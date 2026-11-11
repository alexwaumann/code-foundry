import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyEntry, type SurfaceEntry } from "@/stores/pluginSurfaces";
import { EMPTY_CONTEXT, requestFromSearch, SHOT_TIMEOUT_MS, ShotController, targetOf, type ShotReport, type ShotRequest, type ShotTarget } from "./controller";

function world() {
  const mounts: { watchKey: string; target: ShotTarget; unmounted: boolean }[] = [];
  const followers = new Map<string, (e: SurfaceEntry | undefined) => void>();
  const reports: ShotReport[] = [];
  let fonts: () => void = () => undefined;
  let height = 600;
  const deps = {
    mount: (watchKey: string, target: ShotTarget) => {
      const m = { watchKey, target, unmounted: false };
      mounts.push(m);
      return () => {
        m.unmounted = true;
      };
    },
    follow: (watchKey: string, cb: (e: SurfaceEntry | undefined) => void) => {
      followers.set(watchKey, cb);
      cb(undefined);
      return () => {
        followers.delete(watchKey);
      };
    },
    prepare: vi.fn(() => Promise.resolve()),
    fontsReady: vi.fn(() => new Promise<void>((r) => (fonts = r))),
    painted: () => Promise.resolve(),
    measure: () => height,
    report: (r: ShotReport) => {
      reports.push(r);
    },
  };
  const c = new ShotController(deps);
  const base = emptyEntry({ plugin: "hello", surface: "demo" });
  /** The latest mount's watch takes an entry. */
  const send = (patch: Partial<SurfaceEntry>, mount = mounts.at(-1)) => {
    followers.get(mount?.watchKey ?? "")?.({ ...base, instance: "hello/demo/global", ...patch });
  };
  return {
    c,
    deps,
    mounts,
    reports,
    send,
    /** Lets the fonts load and the queued awaits run. */
    settle: async () => {
      await vi.advanceTimersByTimeAsync(0);
      fonts();
      await vi.advanceTimersByTimeAsync(0);
    },
    setHeight: (h: number) => {
      height = h;
    },
  };
}

const req = (over: Partial<ShotRequest> = {}): ShotRequest => ({ id: "r1", plugin: "hello", surface: "demo", ...over });

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ShotController", () => {
  it("waits for the live phase, the version asked for and the fonts, then reports the height", async () => {
    const w = world();
    w.c.start(req({ minVersion: 3 }));
    expect(w.mounts.map((m) => m.target)).toEqual([{ plugin: "hello", surface: "demo", context: EMPTY_CONTEXT }]);
    w.send({ phase: "opening" });
    w.send({ phase: "live", version: 2 });
    await w.settle();
    expect(w.reports).toEqual([]);
    w.send({ phase: "live", version: 3 });
    // Live at the version: still the fonts.
    await vi.advanceTimersByTimeAsync(0);
    expect(w.deps.fontsReady).toHaveBeenCalledTimes(1);
    expect(w.reports).toEqual([]);
    await w.settle();
    expect(w.reports).toEqual([{ id: "r1", ok: true, contentHeight: 600, version: 3 }]);
    // Reported once; the surface stays on screen.
    w.send({ phase: "live", version: 4 });
    await w.settle();
    expect(w.reports).toHaveLength(1);
    expect(w.mounts[0]?.unmounted).toBe(false);
  });

  it("a view that is not live yet does not count, whatever its version", async () => {
    const w = world();
    w.c.start(req());
    w.send({ phase: "opening", version: 5 });
    w.send({ phase: "not-responding", version: 5 });
    await w.settle();
    expect(w.reports).toEqual([]);
  });

  it("reports the full height of a surface taller than the window, rounded up", async () => {
    const w = world();
    w.setHeight(1834.25);
    w.c.start(req());
    w.send({ phase: "live", version: 1 });
    await w.settle();
    expect(w.reports).toEqual([{ id: "r1", ok: true, contentHeight: 1835, version: 1 }]);
  });

  it.each<[string, Partial<SurfaceEntry>, ShotReport]>([
    ["the plugin down", { phase: "plugin-down", pluginState: "crashed", message: "exit status 2" }, { id: "r1", ok: false, failure: "plugin-down", reason: "exit status 2" }],
    ["the plugin down without words", { phase: "plugin-down", pluginState: "disabled" }, { id: "r1", ok: false, failure: "plugin-down", reason: "the plugin is disabled" }],
    ["the surface failed to open", { phase: "failed", message: "initialize timed out" }, { id: "r1", ok: false, failure: "failed", reason: "initialize timed out" }],
    ["the daemon refused it here", { error: "hello demo is not available here: it shows a thread" }, { id: "r1", ok: false, failure: "unavailable", reason: "hello demo is not available here: it shows a thread" }],
  ])("fails at once on %s, and stops following", async (_name, entry, want) => {
    const w = world();
    w.c.start(req());
    w.send(entry);
    expect(w.reports).toEqual([want]);
    w.send({ phase: "live", version: 1 });
    await w.settle();
    await vi.advanceTimersByTimeAsync(SHOT_TIMEOUT_MS);
    expect(w.reports).toEqual([want]);
  });

  it("waits through a plugin starting again (a dev rebuild)", async () => {
    const w = world();
    w.c.start(req());
    w.send({ phase: "plugin-down", pluginState: "starting" });
    expect(w.reports).toEqual([]);
    w.send({ phase: "live", pluginState: "running", version: 1 });
    await w.settle();
    expect(w.reports).toEqual([{ id: "r1", ok: true, contentHeight: 600, version: 1 }]);
  });

  it("times out with where it got to", async () => {
    const w = world();
    w.c.start(req({ minVersion: 4, timeoutMs: 2000 }));
    w.send({ phase: "live", version: 2 });
    await vi.advanceTimersByTimeAsync(1999);
    expect(w.reports).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(w.reports).toEqual([{ id: "r1", ok: false, failure: "timeout", reason: "no live view at version 4 or later within 2000 ms (phase live, version 2)" }]);
  });

  it("times out after SHOT_TIMEOUT_MS when the request does not say, naming a stream that sent nothing", async () => {
    const w = world();
    w.c.start(req());
    await vi.advanceTimersByTimeAsync(SHOT_TIMEOUT_MS);
    expect(w.reports).toEqual([{ id: "r1", ok: false, failure: "timeout", reason: `no live view at version 1 or later within ${String(SHOT_TIMEOUT_MS)} ms (the stream sent nothing)` }]);
  });

  it("refuses a request that names no surface, mounting nothing", () => {
    const w = world();
    w.c.start(req({ plugin: "", surface: "" }));
    expect(w.mounts).toEqual([]);
    expect(w.reports).toEqual([{ id: "r1", ok: false, failure: "invalid", reason: "a request names a plugin and a surface (or an instance)" }]);
  });

  it("a second request replaces the first: the first unmounts and never reports", async () => {
    const w = world();
    w.c.start(req({ id: "a" }));
    const first = w.mounts[0];
    w.send({ phase: "live", version: 1 });
    // The first is waiting for the fonts when the second comes.
    w.c.start(req({ id: "b", scope: "thread:s-3" }));
    expect(first?.unmounted).toBe(true);
    expect(w.mounts).toHaveLength(2);
    expect(w.mounts[1]?.watchKey).not.toBe(first?.watchKey);
    expect(w.mounts[1]?.target.context.activeThreadId).toBe("s-3");
    await w.settle();
    expect(w.reports).toEqual([]);
    w.send({ phase: "live", version: 1 });
    await w.settle();
    await vi.advanceTimersByTimeAsync(SHOT_TIMEOUT_MS);
    expect(w.reports).toEqual([{ id: "b", ok: true, contentHeight: 600, version: 1 }]);
  });

  it("stop unmounts without a report", async () => {
    const w = world();
    w.c.start(req());
    w.c.stop();
    expect(w.mounts[0]?.unmounted).toBe(true);
    await vi.advanceTimersByTimeAsync(SHOT_TIMEOUT_MS);
    expect(w.reports).toEqual([]);
  });

  it("a theme that cannot be read still reports", async () => {
    const w = world();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    w.deps.prepare.mockImplementation(() => Promise.reject(new Error("daemon gone")));
    w.c.start(req());
    w.send({ phase: "live", version: 1 });
    await w.settle();
    expect(w.reports).toEqual([{ id: "r1", ok: true, contentHeight: 600, version: 1 }]);
  });
});

describe("targetOf", () => {
  it.each<[string, Partial<ShotRequest>, Partial<ShotTarget> | string]>([
    ["no scope is global", {}, { context: EMPTY_CONTEXT }],
    ["global", { scope: "global" }, { context: EMPTY_CONTEXT }],
    ["a thread", { scope: "thread:s-3" }, { context: { ...EMPTY_CONTEXT, activeThreadId: "s-3" } }],
    ["a project", { scope: "project:p-1" }, { context: { ...EMPTY_CONTEXT, activeProjectId: "p-1" } }],
    ["a worktree, colons and all", { scope: "worktree:/tmp/a:b" }, { context: { ...EMPTY_CONTEXT, activeWorktreePath: "/tmp/a:b" } }],
    ["an instance names the plugin and surface", { plugin: "", surface: "", instance: "gh/checks/pr:o/r#4" }, { plugin: "gh", surface: "checks", instance: "gh/checks/pr:o/r#4", context: EMPTY_CONTEXT }],
    ["a pr scope", { scope: "pr:o/r#4" }, 'scope "pr:o/r#4" is not global, thread:<id>, project:<id> or worktree:<path> (a pr scope goes by instance)'],
    ["a thread without an id", { scope: "thread:" }, 'scope "thread:" is not global, thread:<id>, project:<id> or worktree:<path> (a pr scope goes by instance)'],
  ])("%s", (_name, over, want) => {
    const got = targetOf(req(over));
    if (typeof want === "string") expect(got).toBe(want);
    else expect(got).toMatchObject(want);
  });
});

describe("requestFromSearch", () => {
  it("reads the URL's request", () => {
    expect(requestFromSearch("?daemon=x&plugin=hello&surface=demo&scope=thread:s-3&minVersion=2&timeoutMs=500")).toEqual({
      id: "url",
      plugin: "hello",
      surface: "demo",
      scope: "thread:s-3",
      minVersion: 2,
      timeoutMs: 500,
    });
    expect(requestFromSearch("?instance=hello/demo/global&id=7&minVersion=nope")).toEqual({ id: "7", plugin: "", surface: "", instance: "hello/demo/global" });
  });

  it("is null for a URL without one", () => {
    expect(requestFromSearch("?daemon=x&token=y")).toBeNull();
  });
});
