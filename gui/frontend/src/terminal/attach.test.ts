import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachEventView } from "@/api/terminal";
import { AttachController, MAX_BEHIND_BYTES, type AttachState } from "./attach";
import type { Disposable, TermSize, TerminalRenderer } from "./renderer";

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
  write(data: Uint8Array, parsed?: () => void): void {
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
