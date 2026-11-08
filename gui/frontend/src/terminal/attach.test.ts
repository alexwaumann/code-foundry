import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttachEventView } from "@/api/terminal";
import { AttachController, DROP_GRACE_MS, MAX_BEHIND_BYTES, REFUSED_RETRY_MS, type AttachState } from "./attach";
import { TerminalInput } from "./input";
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
  /** Each reset's sameTerminal, in order (calls has "reset" for both). */
  sameTerminal: boolean[] = [];
  reset(sameTerminal = false): void {
    this.calls.push("reset");
    this.sameTerminal.push(sameTerminal);
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
  const pushers = new Map<string, (ev: AttachEventView | "end" | Error) => void>();
  async function* attach(id: string, signal: AbortSignal): AsyncGenerator<AttachEventView> {
    opened.push(id);
    const queue: (AttachEventView | "end" | Error)[] = [];
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
      if (ev instanceof Error) throw ev;
      if (ev) {
        yield ev;
        continue;
      }
      await new Promise<void>((r) => (wake = r));
    }
  }
  return { attach, opened, aborted, push: (id: string, ev: AttachEventView | "end" | Error) => pushers.get(id)?.(ev) };
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
  /** What each Write in flight is waiting for, oldest first. */
  let inFlight: (() => void)[];
  let input: TerminalInput;
  const releaseWrite = () => inFlight.shift()?.();

  beforeEach(() => {
    vi.useFakeTimers();
    r = new FakeRenderer();
    s = streams();
    writes = [];
    resizes = [];
    states = [];
    inFlight = [];
    input = new TerminalInput((id, data) => {
      writes.push([id, new TextDecoder().decode(data)]);
      return new Promise<void>((res) => inFlight.push(res));
    });
    ctl = new AttachController(
      r,
      {
        attach: s.attach,
        input,
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

  it("resets for another terminal on attach, and for the same one again on each snapshot", async () => {
    ctl.attach("t1");
    await flush();
    s.push("t1", { kind: "snapshot", data: enc("one"), cols: 100, rows: 30, altScreen: false });
    await flush();
    s.push("t1", { kind: "snapshot", data: enc("again"), cols: 100, rows: 30, altScreen: false });
    await flush();
    ctl.attach("t2");
    await flush();
    s.push("t2", { kind: "snapshot", data: enc("two"), cols: 100, rows: 30, altScreen: false });
    await flush();
    expect(r.sameTerminal).toEqual([false, true, true, false, true]);
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
    expect(r.calls.slice(4)).toEqual(["fit:100x30", "write:live1"]);
    expect(ctl.current.phase).toBe("live");
    // The Resized waits for the output before it, which was written for the old size.
    r.deferParse.shift()?.();
    expect(r.calls.slice(4)).toEqual(["fit:100x30", "write:live1", "resize:90x12", "write:live2"]);
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

  describe("a stream the daemon drops for falling behind", () => {
    const dropped = new ConnectError("attach subscriber too slow; re-attach for a fresh snapshot", Code.ResourceExhausted);
    const snapshot = { kind: "snapshot" as const, data: enc("now"), cols: 100, rows: 30, altScreen: false };
    /** Past any first backoff, so the next attempt has opened. */
    const BACKOFF_MS = 400;
    const phases = () => states.map((st) => st.phase);
    async function live() {
      ctl.attach("t1");
      await flush();
      s.push("t1", snapshot);
      await flush();
      expect(ctl.current.phase).toBe("live");
    }

    it("stays live through the drop and the reconnect, and for good after it", async () => {
      await live();
      s.push("t1", dropped);
      await vi.advanceTimersByTimeAsync(BACKOFF_MS);
      expect(s.opened).toEqual(["t1", "t1"]);
      expect(ctl.current.phase).toBe("live");

      s.push("t1", snapshot);
      await vi.advanceTimersByTimeAsync(DROP_GRACE_MS * 2);
      expect(phases()).not.toContain("reconnecting");
    });

    it("shows a reconnect that then fails, at once and with why", async () => {
      await live();
      s.push("t1", dropped);
      await vi.advanceTimersByTimeAsync(BACKOFF_MS);
      expect(ctl.current.phase).toBe("live");
      s.push("t1", new TypeError("Load failed"));
      await flush();
      expect(ctl.current).toMatchObject({ phase: "reconnecting", error: "Code Foundry's daemon is not reachable." });
    });

    it("shows a reconnect that hangs, once the grace is over", async () => {
      await live();
      s.push("t1", dropped);
      await vi.advanceTimersByTimeAsync(DROP_GRACE_MS - 1);
      expect(s.opened).toEqual(["t1", "t1"]);
      expect(ctl.current.phase).toBe("live");
      await vi.advanceTimersByTimeAsync(1);
      expect(ctl.current.phase).toBe("reconnecting");

      s.push("t1", snapshot);
      await flush();
      expect(ctl.current.phase).toBe("live");
    });

    it("does not put the deadline off for drops that bring no message", async () => {
      await live();
      s.push("t1", dropped);
      await vi.advanceTimersByTimeAsync(BACKOFF_MS);
      s.push("t1", dropped);
      await flush();
      expect(ctl.current.phase).toBe("live");
      await vi.advanceTimersByTimeAsync(DROP_GRACE_MS - BACKOFF_MS);
      expect(s.opened).toEqual(["t1", "t1", "t1"]);
      expect(ctl.current.phase).toBe("reconnecting");
    });

    it("starts the grace over for each drop after a message", async () => {
      await live();
      for (let i = 0; i < 3; i++) {
        s.push("t1", dropped);
        await vi.advanceTimersByTimeAsync(DROP_GRACE_MS - 1);
        s.push("t1", snapshot);
        await flush();
      }
      expect(phases()).not.toContain("reconnecting");
    });

    it("still shows any other error", async () => {
      await live();
      s.push("t1", new ConnectError("the store is closed", Code.Unavailable));
      await flush();
      expect(ctl.current).toMatchObject({ phase: "reconnecting", error: "the store is closed" });
    });

    it("still shows a stream that ended cleanly", async () => {
      await live();
      s.push("t1", "end");
      await vi.advanceTimersByTimeAsync(BACKOFF_MS);
      expect(ctl.current.phase).toBe("reconnecting");
    });

    it("leaves the next terminal alone when the grace would end after a switch", async () => {
      await live();
      s.push("t1", dropped);
      await flush();
      ctl.attach("t2");
      await vi.advanceTimersByTimeAsync(DROP_GRACE_MS * 2);
      expect(ctl.current).toMatchObject({ terminalId: "t2", phase: "connecting" });
      expect(phases()).not.toContain("reconnecting");
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
    releaseWrite();
    await flush();
    expect(writes).toEqual([
      ["t1", "a"],
      ["t1", "bc"],
    ]);
  });

  describe("typed input around a re-attach", () => {
    const decoded = () => writes.map(([id, text]) => `${id}:${text}`);
    const snap = { kind: "snapshot" as const, data: enc("s"), cols: 100, rows: 30, altScreen: false };
    /** Lets the write in flight return, and what it started. */
    const returnWrite = async () => {
      releaseWrite();
      await flush();
    };

    it("sends what is typed in the next terminal without waiting for the last one's write", async () => {
      ctl.attach("t1");
      await flush();
      r.type("a");
      ctl.attach("t2");
      await flush();
      r.type("b");
      expect(decoded()).toEqual(["t1:a", "t2:b"]);
    });

    it("leaves the next terminal's input and state alone when the last one's write fails", async () => {
      const failed = new Error("gone");
      let failWrite: (err: Error) => void = () => undefined;
      const seen: [string, string][] = [];
      const c = new AttachController(
        r,
        {
          attach: s.attach,
          input: new TerminalInput((id, data) => {
            seen.push([id, new TextDecoder().decode(data)]);
            return id === "t1" ? new Promise<void>((_, reject) => (failWrite = reject)) : Promise.resolve();
          }),
          resize: () => Promise.resolve(),
        },
        () => undefined,
      );
      c.attach("t1");
      await flush();
      r.type("a");
      c.attach("t2");
      await flush();
      r.type("b");
      failWrite(failed);
      await flush();
      expect(seen).toEqual([["t1", "a"], ["t2", "b"]]);
      expect(c.current.error).toBeNull();
      c.dispose();
    });

    it("sends what was queued to the terminal it was typed in, not the one attached by then", async () => {
      ctl.attach("t1");
      await flush();
      r.type("a");
      r.type("queued");
      ctl.attach("t2");
      await flush();
      r.type("b");
      await returnWrite();
      await returnWrite();
      expect(decoded()).toEqual(["t1:a", "t2:b", "t1:queued"]);
    });

    it("keeps each terminal's keys in order through a switch there and back", async () => {
      ctl.attach("t1");
      await flush();
      r.type("a");
      r.type("b");
      ctl.attach("t2");
      await flush();
      r.type("x");
      ctl.attach("t1");
      await flush();
      r.type("c");
      for (let i = 0; i < 3; i++) await returnWrite();
      expect(decoded()).toEqual(["t1:a", "t2:x", "t1:bc"]);
    });

    it("drops the rest of a terminal's keys when a write fails, and only its", async () => {
      let fail: (err: Error) => void = () => undefined;
      const seen: [string, string][] = [];
      const c = new AttachController(
        r,
        {
          attach: s.attach,
          input: new TerminalInput((id, data) => {
            const text = new TextDecoder().decode(data);
            seen.push([id, text]);
            return text === "a" ? new Promise<void>((_, reject) => (fail = reject)) : Promise.resolve();
          }),
          resize: () => Promise.resolve(),
        },
        () => undefined,
      );
      c.attach("t1");
      await flush();
      r.type("a");
      r.type("hole before it");
      c.attach("t2");
      await flush();
      r.type("b");
      fail(new Error("gone"));
      await flush();
      expect(seen).toEqual([["t1", "a"], ["t2", "b"]]);
      c.dispose();
    });

    it("keeps a terminal's keys in order through a remount: a new controller queues behind the old one's", async () => {
      ctl.attach("t1");
      await flush();
      r.type("a");
      r.type("b");
      ctl.dispose();
      const next = new FakeRenderer();
      const c = new AttachController(next, { attach: s.attach, input, resize: () => Promise.resolve() }, () => undefined);
      c.attach("t1");
      await flush();
      next.type("c");
      await returnWrite();
      await returnWrite();
      expect(decoded()).toEqual(["t1:a", "t1:bc"]);
      c.dispose();
    });

    it("shows a failed write in the controller on that terminal, not the disposed one before it", async () => {
      let fail: (err: Error) => void = () => undefined;
      const shared = new TerminalInput(() => new Promise<void>((_, reject) => (fail = reject)));
      const oldErrors: unknown[] = [];
      const old = new AttachController(r, { attach: s.attach, input: shared, resize: () => Promise.resolve(), onStreamError: (e) => oldErrors.push(e) }, () => undefined);
      old.attach("t1");
      await flush();
      r.type("a");
      old.dispose();
      const next = new FakeRenderer();
      const c = new AttachController(next, { attach: s.attach, input: shared, resize: () => Promise.resolve() }, () => undefined);
      c.attach("t1");
      await flush();
      next.type("b");
      fail(new Error("gone"));
      await flush();
      expect(oldErrors).toHaveLength(1);
      expect(old.current.error).toBeNull();
      expect(c.current.error).toBe("write failed: gone");
      c.dispose();
    });

    it("sends each keystroke once through a stream dropped for falling behind, and in order", async () => {
      ctl.attach("t1");
      await flush();
      s.push("t1", snap);
      await flush();
      r.deferParse = [];
      s.push("t1", { kind: "output", data: new Uint8Array(MAX_BEHIND_BYTES) });
      await flush();
      r.type("a");
      s.push("t1", { kind: "output", data: enc("x") }); // over the limit: the stream goes
      await flush();
      expect(s.aborted).toEqual(["t1"]);
      r.type("b");
      await returnWrite();
      r.type("c");
      while (r.deferParse.length) r.deferParse.shift()?.();
      await flush();
      expect(s.opened).toEqual(["t1", "t1"]);
      r.type("d");
      await returnWrite();
      s.push("t1", snap);
      await flush();
      r.type("e");
      await returnWrite();
      await returnWrite();
      expect(decoded().map((d) => d.slice(3)).join("")).toBe("abcde");
      expect(decoded().every((d) => d.startsWith("t1:"))).toBe(true);
    });

    it("sends what is typed while a snapshot waits or is parsed, through the terminal it belongs to", async () => {
      ctl.attach("t1");
      await flush();
      r.deferParse = [];
      r.type("a");
      s.push("t1", snap);
      await flush();
      r.type("b");
      await returnWrite();
      expect(decoded()).toEqual(["t1:a", "t1:b"]);
    });
  });

  describe("a resize around a re-attach", () => {
    const snap = (cols: number, rows: number, text = "s") => ({ kind: "snapshot" as const, data: enc(text), cols, rows, altScreen: false });
    const parseAll = () => {
      while (r.deferParse?.length) r.deferParse.shift()?.();
    };
    /** Every event pushed so far delivered: each takes several ticks of the generator. */
    const delivered = async () => {
      for (let i = 0; i < 4; i++) await flush();
    };
    async function live() {
      r.container = { cols: 100, rows: 30 };
      ctl.attach("t1");
      await flush();
      s.push("t1", snap(100, 30));
      await flush();
      r.calls = [];
    }

    it("keeps a Resized behind the output before it, and the output after behind it", async () => {
      await live();
      r.deferParse = [];
      s.push("t1", { kind: "output", data: enc("old") });
      s.push("t1", { kind: "resized", cols: 90, rows: 20 });
      s.push("t1", { kind: "output", data: enc("new") });
      await delivered();
      expect(r.calls).toEqual(["write:old"]);
      parseAll();
      expect(r.calls).toEqual(["write:old", "resize:90x20", "write:new"]);
    });

    it("keeps that order through a snapshot's replay", async () => {
      ctl.attach("t1");
      await flush();
      r.container = { cols: 100, rows: 30 };
      r.deferParse = [];
      s.push("t1", snap(100, 30));
      s.push("t1", { kind: "output", data: enc("old") });
      s.push("t1", { kind: "resized", cols: 90, rows: 20 });
      s.push("t1", { kind: "output", data: enc("new") });
      await delivered();
      r.calls = [];
      r.deferParse.shift()?.();
      expect(r.calls).toEqual(["write:old"]);
      parseAll();
      expect(r.calls).toEqual(["write:old", "resize:90x20", "write:new"]);
    });

    it("lets a newer snapshot replace a Resized that waits for xterm", async () => {
      await live();
      r.deferParse = [];
      s.push("t1", { kind: "output", data: enc("old") });
      s.push("t1", { kind: "resized", cols: 90, rows: 20 });
      s.push("t1", snap(100, 30, "fresh"));
      await delivered();
      parseAll();
      expect(r.calls).toEqual(["write:old", "reset", "resize:100x30", "write:fresh"]);
    });

    it("attaches again when the grid moved under a snapshot still waiting to parse, which drew at the wrong size", async () => {
      await live();
      r.deferParse = [];
      s.push("t1", snap(100, 30, "fresh"));
      await flush();
      r.size = { cols: 70, rows: 30 }; // the host's fit(), on a frame before xterm's timer
      parseAll();
      await flush();
      expect(s.aborted).toEqual(["t1"]);
      expect(s.opened).toEqual(["t1", "t1"]);
    });

    it("does not loop on a grid that cannot take the snapshot's size", async () => {
      await live();
      r.resize = () => undefined; // xterm's minimum, or a size it clamps
      s.push("t1", snap(1, 1));
      await flush();
      expect(s.aborted).toEqual([]);
      expect(ctl.current.phase).toBe("live");
    });
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
    const ctl = new AttachController(r, { attach: s.attach, input: new TerminalInput(() => Promise.resolve()), resize: () => Promise.resolve() }, () => undefined);
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

  describe("the screen after a re-attach", () => {
    /** Every row of the active buffer, blanks included, and the cursor. */
    const grid = (r: XtermRenderer) => {
      const buf = r.term.buffer.active;
      const rows = Array.from({ length: r.term.rows }, (_, i) => buf.getLine(buf.baseY + i)?.translateToString(true) ?? "");
      return { type: buf.type, rows, x: buf.cursorX, y: buf.cursorY };
    };
    /** What xterm shows for the same bytes and sizes with no stream, no backlog and no controller. */
    async function direct(steps: (string | [number, number])[]) {
      const r = new XtermRenderer({ fontSize: 12, isGlobalChord: () => false });
      for (const step of steps) {
        if (typeof step === "string") await new Promise<void>((resolve) => { r.write(enc(step), resolve); });
        else r.resize(step[0], step[1]);
      }
      const want = grid(r);
      r.dispose();
      return want;
    }
    const ALT = "\x1b[?1049h\x1b[2J\x1b[H";

    it("draws what a snapshot held at the size it was written for, through a resize, in the alternate screen", async () => {
      const { r, s, ctl } = attached();
      ctl.attach("t");
      await flush();
      const steps = [`${ALT}top\x1b[3;70Hedge`, [60, 24], "\x1b[2;50Hmoved"] as (string | [number, number])[];
      r.resize(80, 24);
      s.push("t", { kind: "snapshot", data: enc(ALT), cols: 80, rows: 24, altScreen: true });
      s.push("t", { kind: "output", data: enc("top\x1b[3;70Hedge") });
      s.push("t", { kind: "resized", cols: 60, rows: 24 });
      s.push("t", { kind: "output", data: enc("\x1b[2;50Hmoved") });
      await flush();
      await vi.waitFor(async () => {
        await flush();
        await parsed(r);
        expect(r.term.cols).toBe(60);
        expect(grid(r)).toEqual(await direct([[80, 24], ...steps]));
      });
      ctl.dispose();
      r.dispose();
    });

    it("leaves the alternate screen, and what is under it, as the snapshot says after a flood's reconnect", async () => {
      const { r, s, ctl } = attached();
      ctl.attach("t");
      await flush();
      const under = "shell$ vim\r\n";
      const snapshot = `${under}\x1b[?1049h\x1b[2J\x1b[Hscreen one`;
      s.push("t", { kind: "snapshot", data: enc(snapshot), cols: 80, rows: 24, altScreen: true });
      await flush();
      await parsed(r);
      s.push("t", { kind: "output", data: new Uint8Array(MAX_BEHIND_BYTES + 1) });
      await flush();
      expect(s.aborted).toEqual(["t"]);
      await vi.waitFor(() => {
        expect(s.opened).toHaveLength(2);
      });
      s.push("t", { kind: "snapshot", data: enc(`${under}\x1b[?1049h\x1b[2J\x1b[Hscreen two`), cols: 80, rows: 24, altScreen: true });
      await flush();
      await vi.waitFor(async () => {
        await flush();
        await parsed(r);
        expect(grid(r).rows[0]).toBe("screen two");
      });
      expect(r.term.buffer.active.type).toBe("alternate");
      expect(r.keyboardModes).toBeDefined();
      s.push("t", { kind: "output", data: enc("\x1b[?1049l") });
      await flush();
      await vi.waitFor(async () => {
        await flush();
        await parsed(r);
        expect(r.term.buffer.active.type).toBe("normal");
      });
      expect(screen(r)).toEqual(["shell$ vim"]);
      ctl.dispose();
      r.dispose();
    });

    it("comes out of a program's alternate screen when the snapshot shows it gone", async () => {
      const { r, s, ctl } = attached();
      ctl.attach("t");
      await flush();
      s.push("t", { kind: "snapshot", data: enc("prompt\r\n\x1b[?1049h\x1b[Hfull screen"), cols: 80, rows: 24, altScreen: true });
      await flush();
      await parsed(r);
      s.push("t", { kind: "snapshot", data: enc("prompt\r\ndone\r\n"), cols: 80, rows: 24, altScreen: false });
      await flush();
      await vi.waitFor(async () => {
        await flush();
        await parsed(r);
        expect(r.term.buffer.active.type).toBe("normal");
        expect(screen(r)).toEqual(["prompt", "done"]);
      });
      ctl.dispose();
      r.dispose();
    });
  });

  it.each(["S", "T", "L", "M", "I", "Z", "2;S"])("drains a count of 2^31 - 1 on CSI %s and goes on", async (seq) => {
    const { r, s, ctl } = attached();
    ctl.attach("t");
    await flush();
    s.push("t", { kind: "snapshot", data: enc(""), cols: 80, rows: 24, altScreen: false });
    await flush();
    await parsed(r);
    s.push("t", { kind: "output", data: enc(`\x1b[2147483647${seq}\x1b[1;1Hafter`) });
    await vi.waitFor(async () => {
      await parsed(r);
      expect(screen(r)).toEqual(["after"]);
    });
    await vi.waitFor(() => {
      expect((ctl as unknown as { unparsed: number }).unparsed).toBe(0);
    });
    ctl.dispose();
    r.dispose();
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
