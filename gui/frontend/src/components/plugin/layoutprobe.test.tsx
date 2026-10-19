/**
 * Targeted probes of the layout primitives (docs/notes/plugins-layout-{1..4}*.md), from the
 * layout fuzz pass; each is named by its finding's id (docs/notes/plugins-layout-fixes-gui.md
 * has them, their causes and fixes). A probe for a bug still open would be an `it.fails`
 * (it passes while the bug is there); there are none. The rest are regressions.
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
  it("md-1: a failed earlier choice leaves the detail of a later one still in flight (narrow)", async () => {
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

  it("md-2: with two choices in flight the last row clicked shows as chosen, not the list's first pending row (wide)", () => {
    geo.width = 900;
    mount(view(md({ selected: "" })));
    fireEvent.click(row("r1") as HTMLElement);
    fireEvent.click(row("r3") as HTMLElement);
    // The user clicked r3 last (rows.find over the pending keys took the list's first, r1).
    expect(root()?.dataset.selected).toBe("r3");
  });

  it("md-3: the act answering before the plugin's next view (the daemon coalesces views 100 ms) keeps the detail and Back's focus (narrow)", async () => {
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

  it("tabs-1: a node tab's act answering before the next view keeps the clicked tab active until the view comes", async () => {
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
  it("md-7: a refused choice hands focus back to the row that was chosen (Back, which had it, is gone)", async () => {
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

  it("fill-2: a fill node follows an enclosing pane that becomes a box (auto → px) under the same key", () => {
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

/** Every node kind's renders, counted (the renderers table, wrapped). */
function countAll(): { n: () => number; restore: () => void } {
  const counters = Object.keys(renderers).map((k) => countRenders(k));
  return {
    n: () => counters.reduce((a, c) => a + c.n(), 0),
    restore: () => {
      for (const c of counters) c.restore();
    },
  };
}

const append = (key: string, text: string) => {
  act(() => {
    usePluginSurfacesStore.setState((s) => {
      const e = s.watches.w;
      if (!e) return s;
      return { watches: { w: applySurfaceUpdate(e, { kind: "append", instance: INSTANCE, version: e.version, key, text, lines: [] }) } };
    });
  });
};

/** A view of 16 nodes: a master-detail (and its detail's text), a log, a text, columns holding a grid of ten texts. */
const busy = (tick: string): PluginViewModel =>
  view(
    md({ selected: "r1" }),
    { key: "lg", log: { lines: [{ text: "one" }] } },
    { key: "tick", text: { content: tick } },
    {
      key: "cols",
      columns: {
        items: [
          { key: "c1", children: [{ key: "g", grid: { items: Array.from({ length: 10 }, (_, i) => ({ key: `gi${String(i)}`, children: [{ key: `gt${String(i)}`, text: { content: `cell ${String(i)}` } }] })) } }] },
          { key: "c2", children: [] },
        ],
      },
    },
  );

describe("renders", () => {
  it("render-1: a log append re-renders the log only, not the other nodes (memoized renderers, mapNode's kept identities)", () => {
    const c = countRenders("masterDetail");
    try {
      mount(view(md({ selected: "r1" }), { key: "lg", log: { lines: [{ text: "one" }] } }));
      const before = c.n();
      append("lg", "two\n");
      expect(c.n() - before).toBe(0);
    } finally {
      c.restore();
    }
  });

  it("render-2: a master-detail renders once per change of its own (a stable callback ref)", () => {
    const c = countRenders("masterDetail");
    try {
      mount(view(md({ selected: "r1" })));
      const m0 = c.n();
      pushView(view(md({ selected: "r2" })));
      expect(c.n() - m0).toBe(1);
    } finally {
      c.restore();
    }
  });

  // The numbers in docs/notes/plugins-layout-fixes-gui.md: renders of every kind for one update of a 16-node view
  // (before the fixes 16 for each of the four).
  it("render-1: renders per update of a 16-node view: 1 for an append, 1 for the view after it (the log's lines change back), 0 for an equal view, 1 for a one-text change", () => {
    const c = countAll();
    try {
      mount(busy("0"));
      let at = c.n();
      const step = () => {
        const d = c.n() - at;
        at = c.n();
        return d;
      };
      append("lg", "two\n");
      const a = step();
      pushView(busy("0"));
      const after = step();
      pushView(busy("0"));
      const same = step();
      pushView(busy("1"));
      const one = step();
      expect([a, after, same, one]).toEqual([1, 1, 0, 1]);
    } finally {
      c.restore();
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
  it("tabs-2: the strip's overflow chevrons are re-measured when tab labels change but their count does not", () => {
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

  it("live-5: one tab stop (roving tabIndex), arrows wrap, Home and End move focus without choosing; the panel is labelled by its tab", () => {
    mount(view({ key: "tb", tabs: { items: [{ key: "ta", label: "A" }, { key: "tbb", label: "B" }, { key: "tc", label: "C" }], active: "tbb", children: [{ key: "c", text: { content: "c" } }] } }));
    const tab = (k: string) => document.querySelector<HTMLElement>(`[data-testid="plugin-node-tab"][data-key="${k}"]`) as HTMLElement;
    expect(["ta", "tbb", "tc"].map((k) => tab(k).tabIndex)).toEqual([-1, 0, -1]);
    tab("tbb").focus();
    fireEvent.keyDown(tab("tbb"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("tc"));
    fireEvent.keyDown(tab("tc"), { key: "ArrowRight" });
    expect(document.activeElement).toBe(tab("ta"));
    fireEvent.keyDown(tab("ta"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(tab("tc"));
    fireEvent.keyDown(tab("tc"), { key: "Home" });
    expect(document.activeElement).toBe(tab("ta"));
    expect(["ta", "tbb", "tc"].map((k) => tab(k).tabIndex)).toEqual([0, -1, -1]);
    fireEvent.keyDown(tab("ta"), { key: "End" });
    expect(document.activeElement).toBe(tab("tc"));
    expect(acts.calls).toEqual([]);
    const panel = screen.getByTestId("plugin-tabs-panel");
    expect(tab("tbb").getAttribute("aria-controls")).toBe(panel.id);
    expect(panel.getAttribute("aria-labelledby")).toBe(tab("tbb").id);
  });

  it("live-10: a long tab label is cut at the tab's max width (a tooltip shows it whole)", () => {
    const long = "0-WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW";
    mount(view({ key: "tb", tabs: { items: [{ key: "ta", label: long }, { key: "tbb", label: "B" }], active: "ta", children: [] } }));
    const t = document.querySelector<HTMLElement>('[data-testid="plugin-node-tab"][data-key="ta"]') as HTMLElement;
    expect(t.className).toContain("max-w-[min(16rem,80%)]");
    expect(t.querySelector("span")?.className).toContain("truncate");
    expect(t.hasAttribute("data-tip")).toBe(true);
  });

  it("an active id that is not a tab selects none and still switches on a click", () => {
    mount(view({ key: "tb", tabs: { items: [{ key: "ta", label: "A" }, { key: "tbb", label: "B" }], active: "gone", children: [{ key: "c", text: { content: "c" } }] } }));
    expect(document.querySelectorAll('[data-testid="plugin-node-tab"][aria-selected="true"]')).toHaveLength(0);
    fireEvent.click(document.querySelector('[data-testid="plugin-node-tab"][data-key="ta"]') as HTMLElement);
    expect(acts.calls.map((c) => c.key)).toEqual(["ta"]);
  });
});
