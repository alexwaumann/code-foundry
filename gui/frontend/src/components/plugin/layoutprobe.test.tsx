/**
 * Targeted probes of the layout primitives (docs/notes/plugins-layout-{1..4}*.md), found by
 * the layout fuzz pass (/tmp/cf-layout-fuzz/gui.md). `it.fails` marks a probe that shows a
 * bug today: it passes while the bug is there and fails once it is fixed (then make it an
 * `it`). Plain `it`s are checks that came out clean and stay as regressions.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ActRequestView, MasterDetailData, PluginViewModel, Row, ViewNode } from "@/api/plugin";
import type { ThreadView } from "@/api/threads";
import { applySurfaceUpdate, draftKeyOf, usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { useThreadsStore } from "@/stores/threads";
import { geo, INSTANCE, installGeometry, pushView, resetSurfaceStore, resize, Surface } from "@/test/layoutHarness";
import { useInlineLiveStore } from "./live";
import { renderers } from "./nodes/index";

const acts = vi.hoisted(() => ({ calls: [] as ActRequestView[], settle: [] as ((ok: boolean) => void)[] }));
vi.mock("@/api/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/plugin")>()),
  actOnSurface: vi.fn((req: ActRequestView) => {
    acts.calls.push(req);
    return new Promise<number>((resolve, reject) => {
      acts.settle.push((ok) => {
        if (ok) resolve(req.version);
        else reject(new Error("plugin refused: no"));
      });
    });
  }),
}));
vi.mock("@/components/thread/InlineThread", () => ({ InlineThread: () => <div data-testid="stub-inline-thread" /> }));

beforeEach(() => {
  installGeometry();
  acts.calls = [];
  acts.settle = [];
  resetSurfaceStore();
  useInlineLiveStore.setState({ holders: [], waiting: [] });
  useThreadsStore.setState({
    loaded: true,
    byId: Object.fromEntries(["a", "b", "c"].map((id) => [id, { id, owner: "plugin:fuzz", worktreePath: "/h", state: "disconnected", status: "idle", archivedAtMs: null } as unknown as ThreadView])),
    order: [],
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Settles the oldest (or the i-th) act in flight. */
async function settle(ok: boolean, i = 0): Promise<void> {
  await act(async () => {
    const [s] = acts.settle.splice(i, 1);
    s?.(ok);
    await Promise.resolve();
    await Promise.resolve();
  });
}

const rows: Row[] = [
  { key: "r1", title: "Build #1" },
  { key: "r2", title: "Build #2" },
  { key: "r3", title: "Build #3" },
];

function md(over: Partial<MasterDetailData> = {}, detail: ViewNode[] = [{ key: "d-text", text: { content: "the detail" } }], key = "md"): ViewNode {
  return { key, masterDetail: { list: { rows }, detail, ...over } };
}

const view = (...nodes: ViewNode[]): PluginViewModel => ({ nodes });
const root = (key = "md") => document.querySelector<HTMLElement>(`[data-testid="plugin-master-detail"][data-key="${key}"]`);
const row = (key: string) => document.querySelector<HTMLElement>(`[data-testid="plugin-row"][data-key="${key}"]`);

function mount(v: PluginViewModel) {
  pushView(v);
  return render(<Surface />);
}

describe("master-detail: the optimistic choice", () => {
  it("BUG md-1: a failed earlier choice closes the detail of a later one still in flight (narrow)", async () => {
    geo.width = 360;
    mount(view(md({ selected: "" })));
    fireEvent.click(row("r1") as HTMLElement); // act A
    fireEvent.click(screen.getByTestId("plugin-md-back"));
    fireEvent.click(row("r2") as HTMLElement); // act B
    expect(root()?.dataset.showing).toBe("detail");
    await settle(false, 0); // A is refused; B is still pending
    expect(root()?.dataset.selected).toBe("r2");
    expect(root()?.dataset.showing).toBe("detail");
  });

  it("BUG md-2: with two choices in flight the list's first pending row shows as chosen, not the last clicked (wide)", () => {
    geo.width = 900;
    mount(view(md({ selected: "" })));
    fireEvent.click(row("r1") as HTMLElement);
    fireEvent.click(row("r3") as HTMLElement);
    // The user clicked r3 last; picking = rows.find(pending) takes the list's first pending row, r1.
    expect(root()?.dataset.selected).toBe("r3");
  });

  it("BUG md-3: the act answering before the plugin's next view (the daemon coalesces views 100 ms) flashes the list and drops Back's focus (narrow)", async () => {
    geo.width = 360;
    mount(view(md({ selected: "" })));
    fireEvent.click(row("r2") as HTMLElement);
    expect(root()?.dataset.showing).toBe("detail");
    expect(document.activeElement?.getAttribute("data-testid")).toBe("plugin-md-back");
    await settle(true); // the act is answered; the view with selected r2 is still on its way
    expect(root()?.dataset.showing).toBe("detail");
    expect(root()?.dataset.selected).toBe("r2");
    pushView(view(md({ selected: "r2" })));
    expect(document.activeElement?.getAttribute("data-testid")).toBe("plugin-md-back");
  });

  it("BUG tabs-1: a node tab's act answering before the next view shows the old tab again until it arrives", async () => {
    mount(view({ key: "tb", tabs: { items: [{ key: "ta", label: "A" }, { key: "tbb", label: "B" }], active: "ta", children: [{ key: "a-text", text: { content: "tab A" } }] } }));
    fireEvent.click(document.querySelector('[data-testid="plugin-node-tab"][data-key="tbb"]') as HTMLElement);
    expect(document.querySelector('[data-testid="plugin-node-tab"][data-key="tbb"]')?.getAttribute("aria-selected")).toBe("true");
    await settle(true);
    expect(document.querySelector('[data-testid="plugin-node-tab"][data-key="tbb"]')?.getAttribute("aria-selected")).toBe("true");
  });

  it("a failed choice goes back to the plugin's selection and the list", async () => {
    geo.width = 360;
    mount(view(md({ selected: "r1" })));
    fireEvent.click(row("r2") as HTMLElement);
    await settle(false);
    expect(root()?.dataset.selected).toBe("r1");
    expect(root()?.dataset.showing).toBe("list");
  });

  it("widening with the detail open and narrowing again keeps the detail; a new resetToken goes back to the list", async () => {
    geo.width = 360;
    mount(view(md({ selected: "", resetToken: "1" })));
    fireEvent.click(row("r2") as HTMLElement);
    await settle(true);
    pushView(view(md({ selected: "r2", resetToken: "1" })));
    resize(900);
    expect(root()?.dataset.showing).toBe("both");
    resize(360);
    expect(root()?.dataset.showing).toBe("detail");
    pushView(view(md({ selected: "r2", resetToken: "2" })));
    expect(root()?.dataset.showing).toBe("list");
  });

  it("the plugin deleting the open row (selected → \"\") goes back to the list", () => {
    geo.width = 360;
    mount(view(md({ selected: "r2" })));
    fireEvent.click(row("r2") as HTMLElement);
    expect(root()?.dataset.showing).toBe("detail");
    pushView({ nodes: [{ key: "md", masterDetail: { list: { rows: rows.filter((r) => r.key !== "r2") }, selected: "", detail: [] } }] });
    expect(root()?.dataset.showing).toBe("list");
  });
});

describe("master-detail: Back", () => {
  it("md-4: Back focuses the row whose detail it was (the list draws it in the same commit)", async () => {
    geo.width = 360;
    mount(view(md({ selected: "" })));
    fireEvent.click(row("r2") as HTMLElement);
    await settle(true);
    pushView(view(md({ selected: "r2" })));
    expect(root()?.dataset.showing).toBe("detail");
    (document.activeElement as HTMLElement | null)?.blur();
    fireEvent.click(screen.getByTestId("plugin-md-back"));
    expect(root()?.dataset.showing).toBe("list");
    expect(document.activeElement).toBe(row("r2"));
  });
});

// md-4 and md-6 (Back in a virtualized list; the owed focus paid later) need real layout:
// e2e/plugins-layout-fuzz.spec.ts (jsdom's virtualizer draws no rows at all).
describe("master-detail: focus", () => {
  it("HARDEN md-7: a refused choice drops focus to the document (Back, which had it, is gone; the row does not get it back)", async () => {
    geo.width = 360;
    mount(view(md({ selected: "" })));
    fireEvent.click(row("r2") as HTMLElement);
    expect(document.activeElement?.getAttribute("data-testid")).toBe("plugin-md-back");
    await settle(false);
    expect(root()?.dataset.showing).toBe("list");
    expect(document.activeElement).toBe(row("r2"));
  });
});

describe("scoped state", () => {
  const inner = (sel: string, token = "") => md({ selected: sel, resetToken: token }, [{ key: "inner-form", form: { fields: [{ key: "in-f", name: "note", label: "Note", input: {} }], resetToken: token } }], "inner");
  const nested = (outerSel: string, tab: string, innerSel: string, token = "") =>
    view(md({ selected: outerSel }, [{ key: "tb", tabs: { items: [{ key: "ta", label: "A" }, { key: "tbb", label: "B" }], active: tab, children: tab === "ta" ? [inner(innerSel, token)] : [{ key: "b-text", text: { content: "B" } }] } }], "outer"));

  it("a master-detail in a tabs node in a master-detail's detail keys its form drafts and narrow state like the store's reconcile", () => {
    geo.width = 900; // the outer is wide; the inner too
    mount(nested("r1", "ta", "r2"));
    const input = document.querySelector<HTMLInputElement>('[data-testid="plugin-input"]');
    fireEvent.change(input as HTMLInputElement, { target: { value: "draft" } });
    const keys = Object.keys(usePluginSurfacesStore.getState().drafts);
    expect(keys).toEqual([draftKeyOf(INSTANCE, "\u0001outer=r1\u0001tb=ta\u0001inner=r2", "inner-form")]);
    // A new reset token drops exactly that draft (reconcileResets reaches the same key).
    pushView(nested("r1", "ta", "r2", "1"));
    pushView(nested("r1", "ta", "r2", "2"));
    expect(usePluginSurfacesStore.getState().drafts).toEqual({});
  });

  it("the same field under another outer row, node tab or view tab keeps its own draft", () => {
    geo.width = 900;
    mount(nested("r1", "ta", "r2"));
    fireEvent.change(document.querySelector('[data-testid="plugin-input"]') as HTMLInputElement, { target: { value: "one" } });
    pushView(nested("r3", "ta", "r2"));
    expect(document.querySelector<HTMLInputElement>('[data-testid="plugin-input"]')?.value).toBe("");
    pushView(nested("r1", "ta", "r2"));
    expect(document.querySelector<HTMLInputElement>('[data-testid="plugin-input"]')?.value).toBe("one");
  });

  it("scope-1: a section's collapse is scoped like drafts: collapsing it in one row's detail leaves every other row's (and tab's) as it was", () => {
    geo.width = 900;
    const sec = (sel: string) => view(md({ selected: sel }, [{ key: "notes", section: { title: "Notes", collapsible: true, children: [{ key: `n-${sel}`, text: { content: `notes of ${sel}` } }] } }]));
    mount(sec("r1"));
    fireEvent.click(screen.getByTestId("plugin-section-toggle"));
    expect(screen.getByTestId("plugin-section").getAttribute("data-collapsed")).toBe("true");
    pushView(sec("r2"));
    expect(screen.getByTestId("plugin-section").getAttribute("data-collapsed")).toBeNull();
    pushView(sec("r1"));
    expect(screen.getByTestId("plugin-section").getAttribute("data-collapsed")).toBe("true");
  });
});

describe("fill height", () => {
  it("fill-1: a fill pane is re-measured when the nodes above it change height (not only on the box's resize)", async () => {
    geo.height = 700;
    geo.boxes.p = { top: 100 };
    const v = (text: string): PluginViewModel => view({ key: "above", text: { content: text } }, { key: "p", pane: { height: "fill", children: [{ key: "x", text: { content: "x" } }] } });
    mount(v("short"));
    const pane = () => document.querySelector<HTMLElement>('[data-testid="plugin-pane"][data-key="p"]');
    expect(pane()?.style.height).toBe("584px"); // 700 - 100 - 16
    // The text above grows (or a section above folds, a notice appears): the pane's top moves to 300; the scroll area keeps its size.
    geo.boxes.p = { top: 300 };
    pushView(v("a much longer text that wraps onto three lines"));
    // The box's MutationObserver delivers in a microtask, before the next paint.
    await act(async () => {
      await Promise.resolve();
    });
    expect(pane()?.style.height).toBe("384px");
  });

  it("BUG fill-2: a fill node keeps its first box when an enclosing pane becomes a box (auto → px) under the same key", () => {
    geo.height = 700;
    geo.boxes.outer = { height: 300 };
    const v = (h: "auto" | number): PluginViewModel => view({ key: "outer", pane: { height: h, children: [{ key: "inner", pane: { height: "fill", children: [] } }] } });
    mount(v("auto"));
    const innerPane = () => document.querySelector<HTMLElement>('[data-testid="plugin-pane"][data-key="inner"]');
    expect(innerPane()?.style.height).toBe("684px"); // the scroll area's 700 - 16
    pushView(v(300));
    resize();
    expect(innerPane()?.style.height).toBe("300px");
  });

  it("a fill thread inside a collapsed section mounts and measures when the section opens", () => {
    geo.height = 700;
    geo.boxes.t = { top: 50 };
    mount(view({ key: "s", section: { title: "S", collapsible: true, collapsed: true, children: [{ key: "t", thread: { threadId: "a", height: "fill" } }] } }));
    expect(screen.queryByTestId("plugin-thread")).toBeNull();
    fireEvent.click(screen.getByTestId("plugin-section-toggle"));
    expect(screen.getByTestId("plugin-thread").style.height).toBe("634px");
  });

  it("a fill pane's minHeight above its box wins (the body scrolls)", () => {
    geo.height = 300;
    geo.boxes.p = { top: 100 };
    mount(view({ key: "p", pane: { height: "fill", minHeight: 600, children: [] } }));
    expect(screen.getByTestId("plugin-pane").style.height).toBe("600px");
  });
});

type AnyRenderer = (p: unknown) => ReactNode;

/** Counts a node kind's renders (its entry in the renderers table, wrapped). */
function countRenders(kind: string): { n: () => number; restore: () => void } {
  let n = 0;
  const table = renderers as unknown as Record<string, AnyRenderer>;
  const orig = table[kind] as AnyRenderer;
  table[kind] = (p) => {
    n++;
    return orig(p);
  };
  return {
    n: () => n,
    restore: () => {
      table[kind] = orig;
    },
  };
}

describe("renders", () => {
  it.fails("PERF render-1: a log append re-renders every other node of the view (no renderer is memoized; mapNode's kept identities buy nothing)", () => {
    const c = countRenders("masterDetail");
    try {
      mount(view(md({ selected: "r1" }), { key: "lg", log: { lines: [{ text: "one" }] } }));
      const before = c.n();
      act(() => {
        usePluginSurfacesStore.setState((s) => {
          const e = s.watches.w;
          if (!e) return s;
          return { watches: { w: applySurfaceUpdate(e, { kind: "append", instance: INSTANCE, version: e.version, key: "lg", text: "two\n", lines: [] }) } };
        });
      });
      expect(c.n() - before).toBe(0);
    } finally {
      c.restore();
    }
  });

  it("PERF render-2: a master-detail renders twice for every render of its parent (its inline callback ref detaches and re-attaches, setEl(null) then setEl(el))", () => {
    const c = countRenders("masterDetail");
    const cols = countRenders("columns");
    try {
      mount(view(md({ selected: "r1" }), { key: "cols", columns: { items: [{ key: "c1", children: [] }, { key: "c2", children: [] }] } }));
      const [m0, c0] = [c.n(), cols.n()];
      pushView(view(md({ selected: "r1" }), { key: "cols", columns: { items: [{ key: "c1", children: [] }, { key: "c2", children: [] }] } }));
      expect(cols.n() - c0).toBe(1);
      expect(c.n() - m0).toBe(1);
    } finally {
      c.restore();
      cols.restore();
    }
  });
});

describe("live budget", () => {
  it("threads in a narrow detail and in node tabs hold slots only while drawn, never more than two", async () => {
    geo.width = 360;
    const v = (tab: string): PluginViewModel =>
      view(
        md({ selected: "r1" }, [
          { key: "t-detail", thread: { threadId: "a", height: 200 } },
          { key: "tb", tabs: { items: [{ key: "ta", label: "A" }, { key: "tbb", label: "B" }], active: tab, children: [{ key: `t-${tab}`, thread: { threadId: tab === "ta" ? "b" : "c", height: 200 } }] } },
        ]),
        { key: "t-top", thread: { threadId: "c", height: 200 } },
      );
    mount(v("ta"));
    expect(useInlineLiveStore.getState().holders).toEqual(["thread\u0000w\u0000t-top"]);
    fireEvent.click(row("r1") as HTMLElement);
    const live = () => useInlineLiveStore.getState();
    expect(live().holders.length).toBe(2);
    expect(live().waiting.length).toBe(1);
    // A node tab switch in flight lets the old tab's thread go.
    fireEvent.click(document.querySelector('[data-testid="plugin-node-tab"][data-key="tbb"]') as HTMLElement);
    expect([...live().holders, ...live().waiting]).not.toContain("thread\u0000w\u0000t-ta");
    await settle(true);
    pushView(v("tbb"));
    expect(live().holders.length).toBeLessThanOrEqual(2);
    fireEvent.click(screen.getByTestId("plugin-md-back"));
    expect(live().holders).toEqual(["thread\u0000w\u0000t-top"]);
    expect(live().waiting).toEqual([]);
  });

  it("Attach on a paused node pauses the oldest; when the taker goes, the paused one gets its slot back", () => {
    geo.width = 360;
    mount(view({ key: "t1", thread: { threadId: "a", height: 200 } }, { key: "t2", thread: { threadId: "b", height: 200 } }, md({ selected: "r1" }, [{ key: "t3", thread: { threadId: "c", height: 200 } }])));
    fireEvent.click(row("r1") as HTMLElement);
    fireEvent.click(screen.getByTestId("plugin-live-attach"));
    expect(useInlineLiveStore.getState().holders).toEqual(["thread\u0000w\u0000t2", "thread\u0000w\u0000t3"]);
    fireEvent.click(screen.getByTestId("plugin-md-back"));
    expect(useInlineLiveStore.getState().holders).toEqual(["thread\u0000w\u0000t2", "thread\u0000w\u0000t1"]);
  });
});

describe("tab strip", () => {
  it.fails("BUG tabs-2: the strip's overflow chevrons are not re-measured when tab labels change but their count does not", () => {
    let wide = false;
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tablist" ? (wide ? 900 : 200) : 0;
    });
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (this: HTMLElement) {
      return this.getAttribute("role") === "tablist" ? 200 : 0;
    });
    const v = (label: string): PluginViewModel => view({ key: "tb", tabs: { items: [{ key: "ta", label }, { key: "tbb", label }], active: "ta", children: [] } });
    mount(v("A"));
    expect(screen.getByTestId("plugin-node-tabs").getAttribute("data-overflow-end")).toBeNull();
    wide = true;
    pushView(v("A much longer label for the first tab"));
    expect(screen.getByTestId("plugin-node-tabs").getAttribute("data-overflow-end")).toBe("true");
  });

  it("an active id that is not a tab selects none and still switches on a click", () => {
    mount(view({ key: "tb", tabs: { items: [{ key: "ta", label: "A" }, { key: "tbb", label: "B" }], active: "gone", children: [{ key: "c", text: { content: "c" } }] } }));
    expect(document.querySelectorAll('[data-testid="plugin-node-tab"][aria-selected="true"]')).toHaveLength(0);
    fireEvent.click(document.querySelector('[data-testid="plugin-node-tab"][data-key="ta"]') as HTMLElement);
    expect(acts.calls.map((c) => c.key)).toEqual(["ta"]);
  });
});
