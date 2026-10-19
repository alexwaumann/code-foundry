/**
 * Layout fuzzing (docs/notes/plugins-layout-{1..4}*.md): seeded random views over every node
 * kind and both strips, nested to the depth limit (src/test/layoutFuzzGen.ts), rendered in
 * a surface frame at the widths the layout thresholds sit at (and random ones) through a
 * fake ResizeObserver, then re-rendered as the plugin's next views (mutations) while the
 * user clicks rows, Back, node tabs, section toggles and Attach and acts settle or fail.
 * Every step asserts: nothing throws, the console stays clean (React key warnings, act
 * warnings, nested-button warnings), keyed test ids are unique, the inline live budget
 * holds (never more than INLINE_LIVE_MAX holders, every holder mounted), and after the
 * last unmount every ResizeObserver is disconnected and no slot is held. A failure names
 * its seed: FUZZ_SEED=<n> reruns one, FUZZ_SEEDS=<n> runs more (default 300), FUZZ_START the first, FUZZ_STEPS the steps a seed (12).
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActRequestView } from "@/api/plugin";
import type { TerminalView } from "@/api/terminal";
import type { ThreadView } from "@/api/threads";
import { usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { useTerminalsStore } from "@/stores/terminals";
import { useThreadsStore } from "@/stores/threads";
import { duplicateKeys, FUZZ_TERMINALS, FUZZ_THREADS, FUZZ_WIDTHS, Gen, mutateView, rng } from "@/test/layoutFuzzGen";
import { geo, installGeometry, pushView, resetSurfaceStore, resize, Surface } from "@/test/layoutHarness";
import { INLINE_LIVE_MAX, useInlineLiveStore } from "./live";

const acts = vi.hoisted(() => ({ calls: [] as ActRequestView[], settle: [] as ((ok: boolean) => void)[] }));
vi.mock("@/api/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/plugin")>()),
  actOnSurface: vi.fn((req: ActRequestView) => {
    acts.calls.push(req);
    return new Promise<number>((resolve, reject) => {
      acts.settle.push((ok) => {
        if (ok) resolve(req.version + 1);
        else reject(new Error("plugin refused: no"));
      });
    });
  }),
}));
// The live views themselves are out of scope: a stub per kind (they would open streams).
vi.mock("@/components/thread/InlineThread", () => ({ InlineThread: ({ threadId }: { threadId: string }) => <div data-testid="stub-inline-thread" data-thread={threadId} /> }));
vi.mock("@/components/terminal/TerminalHost", () => ({ TerminalHost: () => <div data-testid="stub-terminal-host" /> }));
// Commands, URLs and copies run on the host: record, do nothing.
vi.mock("@/stores/commands", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/stores/commands")>()),
  runCommandForResult: vi.fn(() => Promise.resolve({})),
  runCommand: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/lib/clipboard", () => ({ copyText: vi.fn(() => Promise.resolve()) }));

beforeEach(() => {
  installGeometry();
  acts.calls = [];
  acts.settle = [];
  useThreadsStore.setState({
    loaded: true,
    byId: Object.fromEntries(FUZZ_THREADS.map((id) => [id, { id, owner: "plugin:fuzz", worktreePath: "/h", state: "disconnected", status: "idle", archivedAtMs: null } as unknown as ThreadView])),
    order: [],
  });
  useTerminalsStore.setState({ loaded: true, byId: Object.fromEntries(FUZZ_TERMINALS.map((id) => [id, { id, state: "running", title: id } as unknown as TerminalView])), order: [] });
  useInlineLiveStore.setState({ holders: [], waiting: [] });
  resetSurfaceStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------
// Checks

/** Test ids that name one element of a node (with its data-key): two of a pair is a bug (or a key collision). */
const KEYED_UNIQUE = new Set([
  "plugin-columns", "plugin-pane", "plugin-grid", "plugin-grid-item", "plugin-column", "plugin-divider", "plugin-spacer", "plugin-group", "plugin-container",
  "plugin-master-detail", "plugin-tabs-node", "plugin-section", "plugin-thread", "plugin-terminal", "plugin-row", "plugin-node-tab", "plugin-tab", "plugin-strip-item", "plugin-group-item", "plugin-empty",
]);
const UNIQUE = ["plugin-scroll", "plugin-top", "plugin-toolbar", "plugin-footer", "plugin-body", "plugin-tabs"];

/** What the runs reached (printed at the end: a fuzz that never opens a detail proves nothing). */
const stats: Record<string, number> = {};
function count(what: string, n = 1): void {
  stats[what] = (stats[what] ?? 0) + n;
}

function domProblems(): string[] {
  const out: string[] = [];
  for (const md of document.querySelectorAll<HTMLElement>('[data-testid="plugin-master-detail"]')) count(`md ${md.dataset.layout ?? ""}/${md.dataset.showing ?? ""}`);
  count("columns row", document.querySelectorAll('[data-testid="plugin-columns"][data-layout="row"]').length);
  count("grid >1 col", document.querySelectorAll('[data-testid="plugin-grid"]:not([data-columns="1"])').length);
  count("live attached", document.querySelectorAll('[data-live="true"]').length);
  count("live paused", document.querySelectorAll('[data-testid="plugin-live-paused"]').length);
  count("tabs switching", document.querySelectorAll('[data-testid="plugin-tabs-node"][data-switching]').length);
  count("md pending", document.querySelectorAll('[data-testid="plugin-md-content"][data-pending]').length);
  count("flex spacer", document.querySelectorAll('[data-testid="plugin-spacer"][data-flex]').length);
  for (const id of UNIQUE) {
    const n = document.querySelectorAll(`[data-testid="${id}"]`).length;
    if (n > 1) out.push(`${String(n)} × ${id}`);
  }
  const seen = new Map<string, number>();
  for (const el of document.querySelectorAll("[data-testid][data-key]")) {
    const id = el.getAttribute("data-testid") ?? "";
    if (!KEYED_UNIQUE.has(id)) continue;
    const k = `${id}[${el.getAttribute("data-key") ?? ""}]`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  for (const [k, n] of seen) if (n > 1) out.push(`${String(n)} × ${k}`);
  // Narrow master-details: showing the detail means a Back button; showing the list means none.
  for (const md of document.querySelectorAll<HTMLElement>('[data-testid="plugin-master-detail"]')) {
    const showing = md.getAttribute("data-showing");
    const back = [...md.children].some((c) => c.getAttribute("data-testid") === "plugin-md-back");
    if (showing === "detail" && !back) out.push(`md ${md.dataset.key ?? ""} shows its detail without Back`);
    if (showing !== "detail" && back) out.push(`md ${md.dataset.key ?? ""} has Back while showing ${showing ?? ""}`);
  }
  // The live budget.
  const live = useInlineLiveStore.getState();
  if (live.holders.length > INLINE_LIVE_MAX) out.push(`${String(live.holders.length)} live holders`);
  for (const h of live.holders) if (live.waiting.includes(h)) out.push(`${h} both holds and waits`);
  for (const id of [...live.holders, ...live.waiting]) {
    const [kind, , key] = id.split("\u0000");
    if (!document.querySelector(`[data-testid="plugin-${kind ?? ""}"][data-key="${key ?? ""}"]`)) out.push(`slot ${kind ?? ""}/${key ?? ""} held by an unmounted node`);
  }
  const attached = document.querySelectorAll('[data-testid="plugin-thread"][data-live="true"], [data-testid="plugin-terminal"][data-live="true"]').length;
  if (attached > INLINE_LIVE_MAX) out.push(`${String(attached)} nodes attached`);
  return out;
}

// ---------------------------------------------------------------------------------------
// User input

async function poke(g: Gen): Promise<string> {
  const r = g.rand();
  const pickEl = (sel: string) => {
    const all = [...document.querySelectorAll<HTMLElement>(sel)];
    return all.length > 0 ? g.pick(all) : null;
  };
  let what = "nothing";
  await act(async () => {
    if (r < 0.25) {
      const el = pickEl('[data-testid="plugin-master-detail"] [data-testid="plugin-row"]');
      if (el) {
        fireEvent.click(el);
        what = `row ${el.dataset.key ?? ""}`;
      }
    } else if (r < 0.35) {
      const el = pickEl('[data-testid="plugin-md-back"]');
      if (el) {
        fireEvent.click(el);
        what = "back";
      }
    } else if (r < 0.5) {
      const el = pickEl('[data-testid="plugin-node-tab"], [data-testid="plugin-tab"]');
      if (el) {
        fireEvent.click(el);
        what = `tab ${el.dataset.key ?? ""}`;
      }
    } else if (r < 0.58) {
      const el = pickEl('[data-testid="plugin-section-toggle"]');
      if (el) {
        fireEvent.click(el);
        what = "toggle";
      }
    } else if (r < 0.63) {
      const el = pickEl('[data-testid="plugin-live-attach"]');
      if (el) {
        fireEvent.click(el);
        what = "attach";
      }
    } else if (r < 0.72) {
      const el = pickEl('[data-testid="plugin-input"]');
      if (el) {
        fireEvent.change(el, { target: { value: g.key("typed") } });
        what = "type";
      }
    } else if (r < 0.9) {
      const n = acts.settle.length;
      if (n > 0) {
        const i = Math.floor(g.rand() * n);
        const [s] = acts.settle.splice(i, 1);
        const ok = g.chance(0.7);
        s?.(ok);
        what = `settle ${ok ? "ok" : "fail"}`;
      }
    } else {
      const el = pickEl('[data-testid="plugin-button"], [data-testid="plugin-chip"]');
      if (el && !(el as HTMLButtonElement).disabled) {
        fireEvent.click(el);
        what = `button ${el.dataset.key ?? ""}`;
      }
    }
    await Promise.resolve();
  });
  return what;
}

function width(g: Gen): number {
  return g.chance(0.7) ? g.pick(FUZZ_WIDTHS) : g.int(0, 2000);
}

// ---------------------------------------------------------------------------------------

/** Console errors and warnings during a run. */
function watchConsole(): { messages: string[]; restore: () => void } {
  const messages: string[] = [];
  const err = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
    messages.push(`error: ${a.map(String).join(" ").slice(0, 400)}`);
  });
  const warn = vi.spyOn(console, "warn").mockImplementation((...a: unknown[]) => {
    messages.push(`warn: ${a.map(String).join(" ").slice(0, 400)}`);
  });
  return {
    messages,
    restore: () => {
      err.mockRestore();
      warn.mockRestore();
    },
  };
}

/** One seed: a view, then `steps` of mutations, resizes and pokes; throws naming the seed and the trail. */
async function runSeed(seed: number, steps: number): Promise<void> {
  const g = new Gen(rng(seed));
  const trail: string[] = [];
  const con = watchConsole();
  const fail = (why: string): never => {
    throw new Error(`layout fuzz seed ${String(seed)}: ${why}\ntrail: ${trail.join(" → ")}\nview: ${JSON.stringify(usePluginSurfacesStore.getState().watches.w?.view).slice(0, 3000)}`);
  };
  try {
    let view = g.view();
    const dups = duplicateKeys(view);
    if (dups.length > 0) fail(`generator made duplicate keys ${dups.join(", ")}`);
    geo.width = width(g);
    trail.push(`w=${String(geo.width)}`);
    pushView(view);
    render(<Surface />);
    const check = () => {
      const p = domProblems();
      if (p.length > 0) fail(p.join("; "));
      if (con.messages.length > 0) fail(con.messages.join("\n"));
    };
    check();
    for (let i = 0; i < steps; i++) {
      const r = g.rand();
      if (r < 0.35) {
        const m = mutateView(view, g);
        view = m.view;
        trail.push(m.what);
        pushView(view);
      } else if (r < 0.5) {
        const w = width(g);
        trail.push(`w=${String(w)}`);
        resize(w);
      } else if (r < 0.55) {
        geo.height = g.pick([0, 200, 240, 700, 2000]);
        trail.push(`h=${String(geo.height)}`);
        resize(geo.width);
      } else {
        const what = await poke(g);
        count(`poke ${what.split(" ")[0] ?? ""}${what.startsWith("settle") ? what.slice(6) : ""}`);
        trail.push(what);
      }
      check();
    }
    // Settle what is left, then unmount: nothing may stay observed or held.
    await act(async () => {
      for (const s of acts.settle.splice(0)) s(g.chance(0.5));
      await Promise.resolve();
    });
    check();
    cleanup();
    if (geo.observed !== 0) fail(`${String(geo.observed)} ResizeObservers still observing after unmount`);
    const live = useInlineLiveStore.getState();
    if (live.holders.length + live.waiting.length > 0) fail(`live slots left after unmount: ${JSON.stringify(live)}`);
    if (con.messages.length > 0) fail(con.messages.join("\n"));
  } finally {
    con.restore();
    cleanup();
    useInlineLiveStore.setState({ holders: [], waiting: [] });
    resetSurfaceStore();
    acts.settle = [];
  }
}

/** Node's process in vitest (the app's tsconfig has no node types). */
const proc = (globalThis as unknown as { process: { env: Record<string, string | undefined>; stdout: { write: (s: string) => void } } }).process;

const ONE = proc.env.FUZZ_SEED ? Number(proc.env.FUZZ_SEED) : null;
const SEEDS = Number(proc.env.FUZZ_SEEDS ?? 300);
const START = Number(proc.env.FUZZ_START ?? 1);
const STEPS = Number(proc.env.FUZZ_STEPS ?? 12);

describe("layout fuzz", () => {
  it("random views over every kind, mutated, resized and clicked, keep the console clean and the invariants", async () => {
    const failures: string[] = [];
    const seeds = ONE !== null ? [ONE] : Array.from({ length: SEEDS }, (_, i) => START + i);
    for (const seed of seeds) {
      try {
        await runSeed(seed, STEPS);
      } catch (e) {
        const msg = e instanceof Error ? (e.message.startsWith("layout fuzz seed") ? e.message : `layout fuzz seed ${String(seed)}: threw ${e.stack ?? e.message}`) : String(e);
        failures.push(msg);
        proc.stdout.write(`\n----\n${msg}\n`);
        if (failures.length >= 5) break;
      }
    }
    proc.stdout.write(`\nlayout fuzz reached: ${JSON.stringify(stats)}\n`);
    expect(failures.map((f) => f.split("\n")[0]).join("\n")).toBe("");
  }, 600_000);
});
