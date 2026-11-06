import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachEventView } from "@/api/terminal";
import { AttachController, MAX_BEHIND_BYTES, REFUSED_RETRY_MS, type AttachState } from "./attach";
import type { Disposable, TermSize, TerminalRenderer } from "./renderer";
import { XtermRenderer } from "./xterm";

/** Records calls; fit() moves the grid to `container` and fires onResize like xterm. */
class FakeRenderer implements TerminalRenderer {
  calls: string[] = [];
  size: TermSize = { cols: 80, rows: 24 };
  container: TermSize = { cols: 100, rows: 30 };
  private dataCbs = new Set<(d: Uint8Array) => void>();
  private resizeCbs = new Set<(s: TermSize) => void>();
  mount(): void {}
  /** When set, a write's `parsed` callback waits here until the test calls it (xterm's async parse). */
  deferParse: (() => void)[] | null = null;
  /** How many writes throw, as xterm's does past its limit. */
  refuse = 0;
  write(data: Uint8Array, parsed?: () => void): void {
    if (this.refuse > 0) {
      this.refuse--;
      throw new Error("write data discarded");
    }
    this.calls.push(`write:${new TextDecoder().decode(data)}`);
    if (!parsed) return;
    if (this.deferParse) this.deferParse.push(parsed);
    else parsed();
  }
  reset(): void {
    this.calls.push("reset");
  }
  hideCursor(): void {
    this.calls.push("hideCursor");
  }
  resize(cols: number, rows: number): void {
    this.size = { cols, rows };
    this.calls.push(`resize:${String(cols)}x${String(rows)}`);
  }
  fit(): void {
    const { cols, rows } = this.container;
    if (cols === this.size.cols && rows === this.size.rows) return;
    this.size = { cols, rows };
    this.calls.push(`fit:${String(cols)}x${String(rows)}`);
    for (const cb of this.resizeCbs) cb(this.size);
  }
  focus(): void {}
  find(): void {}
  findStep(): void {}
  clearFind(): void {}
  onFindResults(): Disposable {
    return { dispose: () => undefined };
  }
  onData(cb: (d: Uint8Array) => void): Disposable {
    this.dataCbs.add(cb);
    return { dispose: () => this.dataCbs.delete(cb) };
  }
  onResize(cb: (s: TermSize) => void): Disposable {
    this.resizeCbs.add(cb);
    return { dispose: () => this.resizeCbs.delete(cb) };
  }
  type(s: string): void {
    for (const cb of this.dataCbs) cb(new TextEncoder().encode(s));
  }
  setFontSize(): void {}
  dispose(): void {}
}

const enc = (s: string) => new TextEncoder().encode(s);

/** Per-terminal scripted Attach streams that stay open until aborted or ended. */
function streams() {
  const opened: string[] = [];
  const aborted: string[] = [];
  const pushers = new Map<string, (ev: AttachEventView | "end") => void>();
  async function* attach(id: string, signal: AbortSignal): AsyncGenerator<AttachEventView> {
    opened.push(id);
    const queue: (AttachEventView | "end")[] = [];
    let wake: (() => void) | null = null;
    pushers.set(id, (ev) => {
      queue.push(ev);
      wake?.();
    });
    signal.addEventListener("abort", () => {
      aborted.push(id);
      wake?.();
    });
    while (!signal.aborted) {
      const ev = queue.shift();
      if (ev === "end") return;
      if (ev) {
        yield ev;
        continue;
      }
      await new Promise<void>((r) => (wake = r));
    }
  }
  return { attach, opened, aborted, push: (id: string, ev: AttachEventView | "end") => pushers.get(id)?.(ev) };
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("AttachController", () => {
  let r: FakeRenderer;
  let s: ReturnType<typeof streams>;
  let writes: [string, string][];
  let resizes: [string, number, number][];
  let states: AttachState[];
  let ctl: AttachController;
  let releaseWrite: (() => void) | null;

  beforeEach(() => {
    vi.useFakeTimers();
    r = new FakeRenderer();
    s = streams();
    writes = [];
    resizes = [];
    states = [];
    releaseWrite = null;
    ctl = new AttachController(
      r,
      {
        attach: s.attach,
        write: (id, data) => {
          writes.push([id, new TextDecoder().decode(data)]);
          return new Promise<void>((res) => (releaseWrite = res));
        },
        resize: (id, cols, rows) => {
          resizes.push([id, cols, rows]);
          return Promise.resolve();
        },
      },
      (st) => states.push(st),
      50,
    );
  });

  afterEach(() => {
    ctl.dispose();
    vi.useRealTimers();
  });

  it("applies a snapshot: reset, size to the PTY, write, then fit and Resize", async () => {
    ctl.attach("t1");
    await flush();
    s.push("t1", { kind: "snapshot", data: enc("hello"), cols: 120, rows: 40, altScreen: false });
    await flush();
    expect(r.calls).toEqual(["reset", "reset", "resize:120x40", "write:hello", "fit:100x30"]);
    expect(ctl.current.phase).toBe("live");
    await vi.advanceTimersByTimeAsync(0);
    expect(resizes).toEqual([["t1", 100, 30]]);
  });

  it("holds output and resizes that arrive while the snapshot is parsed, then applies them in order", async () => {
    r.deferParse = [];
    ctl.attach("t1");
    await flush();
    s.push("t1", { kind: "snapshot", data: enc("replay"), cols: 80, rows: 10, altScreen: false });
    s.push("t1", { kind: "output", data: enc("live1") });
    s.push("t1", { kind: "resized", cols: 90, rows: 12 });
    s.push("t1", { kind: "output", data: enc("live2") });
    for (let i = 0; i < 4; i++) await flush();
    // Nothing after the snapshot touches the grid (no fit, no resize, no output) until it is parsed.
    expect(r.calls).toEqual(["reset", "reset", "resize:80x10", "write:replay"]);
    expect(ctl.current.phase).toBe("connecting");
    r.deferParse.shift()?.();
    expect(r.calls).toEqual(["reset", "reset", "resize:80x10", "write:replay", "fit:100x30", "write:live1", "resize:90x12", "write:live2"]);
    expect(ctl.current.phase).toBe("live");
  });

  it("drops what a snapshot held when a newer snapshot replaces it", async () => {
    r.deferParse = [];
    ctl.attach("t1");
    await flush();
    s.push("t1", { kind: "snapshot", data: enc("old"), cols: 100, rows: 30, altScreen: false });
    s.push("t1", { kind: "output", data: enc("stale") });
    s.push("t1", { kind: "snapshot", data: enc("new"), cols: 100, rows: 30, altScreen: false });
    s.push("t1", { kind: "output", data: enc("fresh") });
    for (let i = 0; i < 4; i++) await flush();
    // The newer snapshot waits for the older one, then meets a reset screen.
    expect(r.calls).not.toContain("write:new");
    r.deferParse.shift()?.();
    expect(r.calls.slice(-3)).toEqual(["reset", "resize:100x30", "write:new"]);
    expect(r.calls).not.toContain("write:fresh");
    r.deferParse.shift()?.();
    expect(r.calls).not.toContain("write:stale");
    expect(r.calls.at(-1)).toBe("write:fresh");
  });

  describe("output that outruns xterm", () => {
    const big = (n = MAX_BEHIND_BYTES / 2) => ({ kind: "output" as const, data: new Uint8Array(n) });
    /** Attached and live, with xterm's parsing left to the test. */
    async function live() {
      ctl.attach("t1");
      await flush();
      s.push("t1", { kind: "snapshot", data: enc("start"), cols: 100, rows: 30, altScreen: false });
      await flush();
      r.deferParse = [];
      r.calls = [];
    }
    const parseAll = () => {
      while (r.deferParse?.length) r.deferParse.shift()?.();
    };

    it("drops the stream at the limit, waits for xterm, and only then opens a new one", async () => {
      await live();
      s.push("t1", big());
      s.push("t1", big());
      await flush();
      expect(s.aborted).toEqual([]);
      s.push("t1", big(1));
      await flush();
      expect(s.aborted).toEqual(["t1"]);
      expect(r.calls.filter((c) => c.startsWith("write:"))).toHaveLength(2);
      // Input still goes, so the program can be stopped: no "Reconnecting…".
      expect(ctl.current.phase).toBe("live");
      await vi.advanceTimersByTimeAsync(1000);
      expect(s.opened).toEqual(["t1"]);

      parseAll();
      await flush();
      expect(s.opened).toEqual(["t1", "t1"]);
      s.push("t1", { kind: "snapshot", data: enc("now"), cols: 100, rows: 30, altScreen: false });
      await flush();
      expect(r.calls.slice(-3)).toEqual(["reset", "resize:100x30", "write:now"]);
    });

    it("never drops a stream xterm keeps up with, however much it sends", async () => {
      await live();
      for (let i = 0; i < 6; i++) {
        s.push("t1", big());
        await flush();
        parseAll();
      }
      expect(s.aborted).toEqual([]);
      expect(s.opened).toEqual(["t1"]);
    });

    it("counts output held behind a snapshot, not the snapshot", async () => {
      await live();
      s.push("t1", { kind: "snapshot", data: new Uint8Array(MAX_BEHIND_BYTES * 2), cols: 100, rows: 30, altScreen: false });
      s.push("t1", big(1));
      await flush();
      expect(s.aborted).toEqual([]);
      s.push("t1", big());
      s.push("t1", big());
      await flush();
      expect(s.aborted).toEqual(["t1"]);
    });

    it("gives a held snapshot's output back to the limit when a newer snapshot drops it", async () => {
      await live();
      s.push("t1", { kind: "snapshot", data: enc("a"), cols: 100, rows: 30, altScreen: false });
      s.push("t1", big());
      s.push("t1", big(MAX_BEHIND_BYTES / 2 - 1));
      s.push("t1", { kind: "snapshot", data: enc("b"), cols: 100, rows: 30, altScreen: false });
      s.push("t1", big());
      await flush();
      expect(s.aborted).toEqual([]);
    });

    it("holds a reconnect's snapshot until xterm has parsed the old output, so it meets a reset screen", async () => {
      await live();
      s.push("t1", { kind: "output", data: enc("old") });
      s.push("t1", { kind: "snapshot", data: enc("snap"), cols: 100, rows: 30, altScreen: false });
      s.push("t1", { kind: "output", data: enc("after") });
      for (let i = 0; i < 4; i++) await flush();
      expect(r.calls).toEqual(["write:old"]);
      parseAll();
      expect(r.calls).toEqual(["write:old", "reset", "resize:100x30", "write:snap", "write:after"]);
    });

    it("does the same across a tab switch, whose new terminal must not meet the old one's output", async () => {
      await live();
      s.push("t1", { kind: "output", data: enc("old") });
      await flush();
      ctl.attach("t2");
      await flush();
      r.calls = [];
      s.push("t2", { kind: "snapshot", data: enc("other"), cols: 100, rows: 30, altScreen: false });
      await flush();
      expect(r.calls).toEqual([]);
      parseAll();
      expect(r.calls).toEqual(["reset", "resize:100x30", "write:other"]);
    });

    it("opens nothing for a terminal that was detached while xterm caught up", async () => {
      await live();
      s.push("t1", big());
      s.push("t1", big());
      s.push("t1", big());
      await flush();
      ctl.detach();
      parseAll();
      await flush();
      expect(s.opened).toEqual(["t1"]);
    });
  });

  describe("a write xterm refuses", () => {
    const snap = (text: string) => ({ kind: "snapshot" as const, data: enc(text), cols: 100, rows: 30, altScreen: false });
    beforeEach(() => {
      vi.spyOn(console, "warn").mockImplementation(() => undefined);
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("re-attaches when it was the snapshot's, and the next snapshot goes live", async () => {
      ctl.attach("t1");
      await flush();
      r.refuse = 1;
      s.push("t1", snap("lost"));
      await flush();
      expect(s.aborted).toEqual(["t1"]);
      expect(ctl.current.phase).toBe("connecting");

      await vi.advanceTimersByTimeAsync(REFUSED_RETRY_MS);
      await flush();
      expect(s.opened).toEqual(["t1", "t1"]);
      s.push("t1", snap("back"));
      await flush();
      expect(r.calls.at(-1)).toBe("write:back");
      expect(ctl.current.phase).toBe("live");
    });

    it("re-attaches when it was output, and takes that output off the limit", async () => {
      ctl.attach("t1");
      await flush();
      s.push("t1", snap("start"));
      await flush();
      r.refuse = 1;
      s.push("t1", { kind: "output", data: new Uint8Array(MAX_BEHIND_BYTES) });
      await flush();
      expect(s.aborted).toEqual(["t1"]);
      await vi.advanceTimersByTimeAsync(REFUSED_RETRY_MS);
      s.push("t1", snap("back"));
      s.push("t1", { kind: "output", data: new Uint8Array(MAX_BEHIND_BYTES) });
      await flush();
      expect(s.aborted).toEqual(["t1"]);
    });

    it("waits for what xterm still has before it attaches again", async () => {
      ctl.attach("t1");
      await flush();
      s.push("t1", snap("start"));
      await flush();
      r.deferParse = [];
      s.push("t1", { kind: "output", data: enc("old") });
      await flush();
      r.refuse = 1;
      s.push("t1", { kind: "output", data: enc("lost") });
      await flush();
      await vi.advanceTimersByTimeAsync(REFUSED_RETRY_MS * 3);
      expect(s.opened).toEqual(["t1"]);

      while (r.deferParse.length) r.deferParse.shift()?.();
      await vi.advanceTimersByTimeAsync(REFUSED_RETRY_MS);
      expect(s.opened).toEqual(["t1", "t1"]);
    });

    it("drops the rest of a replay, and leaves its output off the limit", async () => {
      ctl.attach("t1");
      await flush();
      r.deferParse = [];
      s.push("t1", snap("start"));
      s.push("t1", { kind: "output", data: enc("first") });
      s.push("t1", { kind: "output", data: new Uint8Array(MAX_BEHIND_BYTES - 5) });
      await flush();
      r.refuse = 1;
      r.deferParse.shift()?.();
      expect(s.aborted).toEqual(["t1"]);
      expect(r.calls.filter((c) => c.startsWith("write:"))).toEqual(["write:start"]);

      await vi.advanceTimersByTimeAsync(REFUSED_RETRY_MS);
      r.deferParse = null;
      s.push("t1", snap("back"));
      s.push("t1", { kind: "output", data: new Uint8Array(MAX_BEHIND_BYTES) });
      await flush();
      expect(s.aborted).toEqual(["t1"]);
      expect(ctl.current.phase).toBe("live");
    });

    it("tries again at its own pace while xterm keeps refusing", async () => {
      ctl.attach("t1");
      await flush();
      r.refuse = Number.POSITIVE_INFINITY;
      for (let i = 0; i < 3; i++) {
        s.push("t1", snap("lost"));
        await flush();
        await vi.advanceTimersByTimeAsync(REFUSED_RETRY_MS - 1);
        expect(s.opened).toHaveLength(i + 1);
        await vi.advanceTimersByTimeAsync(1);
        await flush();
        expect(s.opened).toHaveLength(i + 2);
      }
    });

    it("opens nothing for a terminal that was detached during the wait", async () => {
      ctl.attach("t1");
      await flush();
      r.refuse = 1;
      s.push("t1", snap("lost"));
      await flush();
      ctl.detach();
      await vi.advanceTimersByTimeAsync(REFUSED_RETRY_MS);
      expect(s.opened).toEqual(["t1"]);
    });
  });

  it("writes output, applies Resized without echoing a Resize, and shows exit", async () => {
    ctl.attach("t1");
    await flush();
    s.push("t1", { kind: "snapshot", data: enc(""), cols: 100, rows: 30, altScreen: false });
    s.push("t1", { kind: "output", data: enc("x") });
    s.push("t1", { kind: "resized", cols: 90, rows: 20 });
    s.push("t1", { kind: "exited", exitCode: 2 });
    await flush();
    await vi.advanceTimersByTimeAsync(100);
    // The cursor goes after the output (an exited terminal takes no input).
    expect(r.calls.slice(-3)).toEqual(["write:x", "resize:90x20", "hideCursor"]);
    expect(resizes).toEqual([]);
    expect(ctl.current).toMatchObject({ phase: "exited", exitCode: 2 });
    // No reconnect after the stream ends post-exit.
    s.push("t1", "end");
    await vi.advanceTimersByTimeAsync(20_000);
    expect(s.opened).toEqual(["t1"]);
  });

  it("aborts the old stream before attaching the next and drops its late events", async () => {
    ctl.attach("t1");
    await flush();
    ctl.attach("t2");
    await flush();
    expect(s.aborted).toEqual(["t1"]);
    expect(s.opened).toEqual(["t1", "t2"]);
    s.push("t1", { kind: "output", data: enc("stale") });
    s.push("t2", { kind: "snapshot", data: enc("fresh"), cols: 100, rows: 30, altScreen: false });
    await flush();
    expect(r.calls).not.toContain("write:stale");
    expect(r.calls).toContain("write:fresh");
    expect(ctl.current.terminalId).toBe("t2");
  });

  it("queues input: one Write in flight, later keystrokes coalesced in order", async () => {
    ctl.attach("t1");
    await flush();
    s.push("t1", { kind: "snapshot", data: enc(""), cols: 100, rows: 30, altScreen: false });
    await flush();
    r.type("a");
    r.type("b");
    r.type("c");
    await flush();
    expect(writes).toEqual([["t1", "a"]]);
    releaseWrite?.();
    await flush();
    expect(writes).toEqual([
      ["t1", "a"],
      ["t1", "bc"],
    ]);
  });

  it("debounces viewport resizes into one Resize", async () => {
    ctl.attach("t1");
    await flush();
    s.push("t1", { kind: "snapshot", data: enc(""), cols: 100, rows: 30, altScreen: false });
    await flush();
    r.container = { cols: 101, rows: 30 };
    r.fit();
    r.container = { cols: 102, rows: 31 };
    r.fit();
    await vi.advanceTimersByTimeAsync(49);
    expect(resizes).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(resizes).toEqual([["t1", 102, 31]]);
  });

  it("ignores input while exited", async () => {
    ctl.attach("t1");
    await flush();
    s.push("t1", { kind: "snapshot", data: enc(""), cols: 100, rows: 30, altScreen: false });
    s.push("t1", { kind: "exited", exitCode: 0 });
    await flush();
    r.type("x");
    await flush();
    expect(writes).toEqual([]);
  });
});

/** xterm's own write buffer: its reset() leaves it alone, and it throws past 50 MB. */
describe("AttachController on a real xterm", () => {
  const screen = (r: XtermRenderer) => {
    const buf = r.term.buffer.active;
    return Array.from({ length: buf.length }, (_, i) => buf.getLine(i)?.translateToString(true) ?? "").filter(Boolean);
  };
  const parsed = (r: XtermRenderer) =>
    new Promise<void>((resolve) => {
      r.term.write("", resolve);
    });

  function attached() {
    const r = new XtermRenderer({ fontSize: 12, isGlobalChord: () => false });
    const s = streams();
    const ctl = new AttachController(r, { attach: s.attach, write: () => Promise.resolve(), resize: () => Promise.resolve() }, () => undefined);
    return { r, s, ctl };
  }

  it("comes back from a flood with the snapshot's screen and no output before it", async () => {
    const { r, s, ctl } = attached();
    ctl.attach("t");
    await flush();
    s.push("t", { kind: "snapshot", data: enc("start\r\n"), cols: 80, rows: 24, altScreen: false });
    await flush();
    // In one task, as a page that was stopped delivers it: 64 MiB is past xterm's limit.
    const chunk = enc("y\r\n".repeat(1 << 18));
    for (let i = 0; i < 64 && s.aborted.length === 0; i++) {
      s.push("t", { kind: "output", data: chunk });
      await flush();
    }
    expect(s.aborted).toEqual(["t"]);

    await vi.waitFor(() => {
      expect(s.opened).toEqual(["t", "t"]);
    });
    s.push("t", { kind: "snapshot", data: enc("fresh\r\n"), cols: 80, rows: 24, altScreen: false });
    s.push("t", { kind: "output", data: enc("after\r\n") });
    await flush();
    await vi.waitFor(async () => {
      await parsed(r);
      expect(screen(r)).toEqual(["fresh", "after"]);
    });
    expect(ctl.current.phase).toBe("live");
    ctl.dispose();
    r.dispose();
  });

  // xterm refuses a write made while it counts more than 50 MB as pending, and it counts a write
  // until its callback has returned. NUL is cheap to parse, and every case is past the limit.
  describe("a snapshot near xterm's limit", () => {
    const snapshotOf = (size: number, tail: string) => {
      const data = new Uint8Array(size);
      data.set(enc(tail), size - tail.length);
      return { kind: "snapshot" as const, data, cols: 80, rows: 24, altScreen: false };
    };

    it.each([
      { name: "past it, with output held", size: 60_000_000, chunks: 1 },
      { name: "under it until the replay passes it", size: 49_000_000, chunks: 32 },
    ])("replays what it held when $name", async ({ size, chunks }) => {
      const { r, s, ctl } = attached();
      ctl.attach("t");
      await flush();
      s.push("t", snapshotOf(size, "snap\r\n"));
      const chunk = new Uint8Array(64 << 10);
      chunk.set(enc("held\r\n"));
      for (let i = 0; i < chunks; i++) s.push("t", { kind: "output", data: chunk });
      await flush();
      await vi.waitFor(() => {
        expect(ctl.current.phase).toBe("live");
      }, 10_000);
      s.push("t", { kind: "output", data: enc("later\r\n") });
      await vi.waitFor(async () => {
        await flush();
        await parsed(r);
        expect(screen(r)).toContain("later");
      });
      expect(s.aborted).toEqual([]);
      ctl.dispose();
      r.dispose();
    }, 20_000);

    it("writes a newer snapshot over one past it", async () => {
      const { r, s, ctl } = attached();
      ctl.attach("t");
      await flush();
      s.push("t", snapshotOf(60_000_000, "first\r\n"));
      await flush();
      s.push("t", snapshotOf(60_000_000, "second\r\n"));
      await flush();
      await vi.waitFor(() => {
        expect(ctl.current.phase).toBe("live");
      }, 10_000);
      await parsed(r);
      expect(screen(r)).toEqual(["second"]);
      expect(s.aborted).toEqual([]);
      ctl.dispose();
      r.dispose();
    }, 20_000);

    it("comes back when a reconnect follows one past it", async () => {
      const { r, s, ctl } = attached();
      ctl.attach("t");
      await flush();
      s.push("t", snapshotOf(60_000_000, "first\r\n"));
      s.push("t", { kind: "output", data: enc("held\r\n") });
      await flush();
      await vi.waitFor(() => {
        expect(ctl.current.phase).toBe("live");
      }, 10_000);
      s.push("t", { kind: "snapshot", data: enc("fresh\r\n"), cols: 80, rows: 24, altScreen: false });
      await flush();
      await vi.waitFor(async () => {
        await flush();
        await parsed(r);
        expect(screen(r)).toEqual(["fresh"]);
      });
      ctl.dispose();
      r.dispose();
    }, 20_000);
  });

  it("shows only the snapshot after a reconnect with output still unparsed", async () => {
    const { r, s, ctl } = attached();
    ctl.attach("t");
    await flush();
    s.push("t", { kind: "snapshot", data: enc(""), cols: 80, rows: 24, altScreen: false });
    await flush();
    await parsed(r); // past the snapshot, or "old" would wait behind it
    s.push("t", { kind: "output", data: enc("old\r\n") });
    s.push("t", { kind: "snapshot", data: enc("snap\r\n"), cols: 80, rows: 24, altScreen: false });
    // Both in this task: xterm parses on a timer, so "old" is still in its buffer.
    for (let i = 0; i < 4; i++) await flush();
    await vi.waitFor(async () => {
      await parsed(r);
      expect(screen(r)).toEqual(["snap"]);
    });
    ctl.dispose();
    r.dispose();
  });
});
