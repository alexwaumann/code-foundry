import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DictationEndView } from "@/api/dictation";
import { OverlayController, THEME_POLL_MS, type OverlayDeps } from "./controller";
import type { Scope, ScopeColours } from "./scope";

const colours: ScopeColours = { plate: [0, 0, 0], edge: [1, 1, 1], live: [2, 2, 2], hot: [3, 3, 3], work: [4, 4, 4], err: [5, 5, 5] };

type Handlers = Parameters<OverlayDeps["follow"]>[1];

function world(reduced = false) {
  let queued: ((ms: number) => void)[] = [];
  let now = 0;
  const follows: { id: string; h: Handlers; stopped: boolean }[] = [];
  const painted: Scope[] = [];
  const deps = {
    requestFrame: vi.fn((cb: (ms: number) => void) => {
      queued.push(cb);
      return queued.length;
    }),
    reducedMotion: () => reduced,
    follow: (id: string, h: Handlers) => {
      const f = { id, h, stopped: false };
      follows.push(f);
      return () => {
        f.stopped = true;
      };
    },
    colours: vi.fn(() => Promise.resolve(colours)),
    paint: (s: Scope) => {
      painted.push(s);
    },
    clear: vi.fn(),
    done: vi.fn(),
  };
  const c = new OverlayController(deps);
  /** Runs `ms` of 60 Hz frames, as far as any are asked for. */
  const frames = (ms: number) => {
    for (let t = 0; t < ms; t += 16) {
      const q = queued;
      queued = [];
      now += 16;
      for (const cb of q) cb(now);
    }
  };
  return { c, deps, follows, painted, frames, pending: () => queued.length };
}

const end = (w: ReturnType<typeof world>, reason: DictationEndView) => {
  w.follows.at(-1)?.h.onEnded(reason);
};

describe("OverlayController", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does nothing before a session: no frame, no stream, no timer", () => {
    const w = world();
    w.frames(100);
    expect(w.deps.requestFrame).not.toHaveBeenCalled();
    expect(w.follows).toHaveLength(0);
    vi.advanceTimersByTime(THEME_POLL_MS * 3);
    expect(w.deps.colours).not.toHaveBeenCalled();
  });

  it("plays a session to its end, then holds nothing and asks once to hide", async () => {
    const w = world();
    w.c.begin("s1");
    await vi.advanceTimersByTimeAsync(0);
    w.frames(200);
    expect(w.painted.length).toBeGreaterThan(5);
    expect(w.pending()).toBe(1);
    w.follows[0]?.h.onStopping();
    w.frames(200);
    expect(w.painted.at(-1)?.phase).toBe("working");
    end(w, "stopped");
    expect(w.follows[0]?.stopped).toBe(true);
    w.frames(1000);
    expect(w.deps.done).toHaveBeenCalledTimes(1);
    expect(w.deps.done).toHaveBeenCalledWith("s1");
    expect(w.deps.clear).toHaveBeenCalledTimes(1);
    expect(w.pending()).toBe(0);
    const asked = w.deps.requestFrame.mock.calls.length;
    w.deps.colours.mockClear();
    vi.advanceTimersByTime(THEME_POLL_MS * 3);
    w.frames(500);
    expect(w.deps.requestFrame.mock.calls.length).toBe(asked);
    expect(w.deps.colours).not.toHaveBeenCalled();
  });

  it("rereads the theme while showing, so a change reaches a plate on screen", async () => {
    const w = world();
    w.deps.colours.mockResolvedValueOnce(colours).mockResolvedValue({ ...colours, live: [9, 9, 9] });
    w.c.begin("s1");
    await vi.advanceTimersByTimeAsync(THEME_POLL_MS);
    expect(w.deps.colours).toHaveBeenCalledTimes(2);
  });

  it("a second begin for the session is nothing", () => {
    const w = world();
    w.c.begin("s1");
    w.c.begin("s1");
    expect(w.follows).toHaveLength(1);
    expect(w.pending()).toBe(1);
  });

  it("the next session takes over a plate still fading, with one frame loop", async () => {
    const w = world();
    w.c.begin("s1");
    await vi.advanceTimersByTimeAsync(0);
    w.frames(200);
    end(w, "stopped");
    w.frames(32);
    w.c.begin("s2");
    expect(w.pending()).toBe(1);
    w.frames(1000);
    expect(w.deps.done).not.toHaveBeenCalled();
    expect(w.painted.at(-1)?.phase).toBe("listening");
    expect(w.follows.map((f) => f.id)).toEqual(["s1", "s2"]);
  });

  it("a level of a replaced session does not reach the new one", () => {
    const w = world();
    w.c.begin("s1");
    const old = w.follows[0]?.h;
    w.c.begin("s2");
    old?.onLevel(0.2);
    old?.onEnded("error");
    w.frames(100);
    expect(w.deps.done).not.toHaveBeenCalled();
  });

  it("a stream that gave up collapses the plate", async () => {
    const w = world();
    w.c.begin("s1");
    await vi.advanceTimersByTimeAsync(0);
    w.frames(100);
    w.follows[0]?.h.onLost();
    w.frames(1000);
    expect(w.deps.done).toHaveBeenCalledWith("s1");
  });

  it("uses the still scope under Reduce Motion", async () => {
    const w = world(true);
    w.c.begin("s1");
    await vi.advanceTimersByTimeAsync(0);
    w.frames(100);
    expect(w.painted.at(-1)?.still).toBe(true);
  });

  it("a session after a hide starts from a closed plate", async () => {
    const w = world();
    w.c.begin("s1");
    await vi.advanceTimersByTimeAsync(0);
    w.frames(300);
    end(w, "discarded");
    w.frames(600);
    const before = w.painted.at(-1);
    w.c.begin("s2");
    await vi.advanceTimersByTimeAsync(0);
    w.frames(32);
    expect(w.painted.at(-1)).not.toBe(before);
    expect(w.painted.at(-1)?.alpha).toBeLessThan(0.6);
  });
});
