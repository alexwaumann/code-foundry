/**
 * The master-detail and tabs nodes (docs/notes/plugins-layout-4-master-detail.md): the wide
 * rule and the list width, the narrow list → detail → back flow kept in the surface store,
 * the select act (optimistic, reverted on failure), the reset rules, the empty detail, a
 * row's own action, the height cap, live nodes letting go, a tabs node's strip and act,
 * and drafts per node tab and per selected row. jsdom has no layout: a fake geometry gives
 * elements a width and a height by data-key (or the surface's scroll area), and the
 * ResizeObserver stub re-measures on demand.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { childLists, nodeScope, withChildLists, type ActRequestView, type MasterDetailData, type PluginViewModel, type Row, type ViewNode } from "@/api/plugin";
import { emptyContext } from "@/stores/context";
import { applyUpdateToState, draftKeyOf, emptyEntry, formsOf, reconcileDetails, reconcileResets, usePluginSurfacesStore, walkScoped } from "@/stores/pluginSurfaces";
import { demoView } from "@/test/pluginFixtures";
import { ViewContext, type ViewCtx } from "./context";
import { FILL_MIN } from "./height";
import { MASTER_DETAIL_GAP, MASTER_DETAIL_LIST_WIDTH, MASTER_DETAIL_MIN_DETAIL, masterDetailListWidth, masterDetailWide } from "./layout";
import { LeavingNode, useLeavingViewTab } from "./live";
import { NodeList } from "./NodeList";
import { SurfaceFrame } from "./SurfaceFrame";

const acts = vi.hoisted(() => ({ calls: [] as ActRequestView[], settle: [] as ((ok: boolean) => void)[] }));
vi.mock("@/api/plugin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/api/plugin")>()),
  actOnSurface: vi.fn((req: ActRequestView) => {
    acts.calls.push(req);
    return new Promise<number>((resolve, reject) => {
      acts.settle.push((ok) => {
        if (ok) resolve(2);
        else reject(new Error("plugin refused: no"));
      });
    });
  }),
}));

const INSTANCE = "hello/demo/thread:s-1";
const ctx: ViewCtx = { watchKey: "w", instance: INSTANCE, version: 1, plugin: "hello", viewTab: "run-list", uiContext: emptyContext, inert: false };
const DK = draftKeyOf(INSTANCE, "run-list", "md");

let boxes: Record<string, { top: number; height: number; width: number }> = {};
let observers: (() => void)[] = [];

function boxOf(el: Element) {
  if (el.getAttribute("data-testid") === "plugin-scroll") return boxes["scroll-root"];
  const key = el.getAttribute("data-key");
  return key === null ? undefined : boxes[key];
}

beforeEach(() => {
  boxes = {};
  observers = [];
  acts.calls = [];
  acts.settle = [];
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const b = boxOf(this) ?? { top: 0, height: 0, width: 0 };
    return { top: b.top, bottom: b.top + b.height, left: 0, right: b.width, width: b.width, height: b.height, x: 0, y: b.top, toJSON: () => ({}) };
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (this: HTMLElement) {
    return boxOf(this)?.height ?? 0;
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private readonly cb: () => void;
      constructor(cb: () => void) {
        this.cb = cb;
      }
      observe(): void {
        observers.push(this.cb);
      }
      unobserve(): void {}
      disconnect(): void {
        observers = observers.filter((o) => o !== this.cb);
      }
    },
  );
  usePluginSurfacesStore.setState({ watches: { w: { ...emptyEntry({ plugin: "hello", surface: "demo" }), instance: INSTANCE, version: 1, phase: "live" } }, drafts: {}, resetTokens: {}, pending: {}, submitted: {}, details: {}, choices: {} });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  usePluginSurfacesStore.setState({ watches: {}, drafts: {}, resetTokens: {}, collapsed: {}, pending: {}, submitted: {}, details: {}, choices: {} });
});

function resize(): void {
  act(() => {
    for (const o of [...observers]) o();
  });
}

const rows: Row[] = [
  { key: "r1", title: "Build #1" },
  { key: "r2", title: "Build #2" },
  { key: "r3", title: "Build #3", action: { event: "open", data: "3" } },
  { key: "r4", title: "Docs", action: { openUrl: "https://x.example" } },
];

function mdNode(over: Partial<MasterDetailData> = {}, detail: ViewNode[] = [{ key: "d-text", text: { content: "the detail" } }]): ViewNode {
  return { key: "md", masterDetail: { list: { rows }, detail, emptyDetail: { title: "No run chosen" }, ...over } };
}

function inSurface(children: ReactNode, c: Partial<ViewCtx> = {}) {
  return render(
    <ViewContext.Provider value={{ ...ctx, ...c }}>
      <SurfaceFrame top={null} toolbar={[]} footer={[]}>
        {children}
      </SurfaceFrame>
    </ViewContext.Provider>,
  );
}

const root = () => screen.getByTestId("plugin-master-detail");
const row = (key: string) => {
  const el = document.querySelector<HTMLElement>(`[data-testid="plugin-row"][data-key="${key}"]`);
  if (!el) throw new Error(`no row ${key}`);
  return el;
};

async function settle(ok: boolean) {
  await act(async () => {
    acts.settle.shift()?.(ok);
    await Promise.resolve();
  });
}

describe("master-detail layout numbers", () => {
  it("takes a list width in 200..400, else 280", () => {
    expect(masterDetailListWidth({ list: {}, detail: [] })).toBe(MASTER_DETAIL_LIST_WIDTH);
    expect(masterDetailListWidth({ list: {}, detail: [], listWidth: 200 })).toBe(200);
    expect(masterDetailListWidth({ list: {}, detail: [], listWidth: 400 })).toBe(400);
    for (const w of [199, 401, 0, -5, 250.5]) expect(masterDetailListWidth({ list: {}, detail: [], listWidth: w })).toBe(280);
  });

  it("is wide from listWidth + 12 + 320", () => {
    expect(MASTER_DETAIL_LIST_WIDTH + MASTER_DETAIL_GAP + MASTER_DETAIL_MIN_DETAIL).toBe(612);
    expect(masterDetailWide(null, 280)).toBe(false);
    expect(masterDetailWide(611, 280)).toBe(false);
    expect(masterDetailWide(612, 280)).toBe(true);
    expect(masterDetailWide(531, 200)).toBe(false);
    expect(masterDetailWide(532, 200)).toBe(true);
    expect(masterDetailWide(360, 280)).toBe(false);
  });
});

describe("walks and scopes", () => {
  const tabs: ViewNode = { key: "tb", tabs: { items: [{ key: "a", label: "A" }, { key: "b", label: "B" }], active: "b", children: [{ key: "f2", form: { fields: [] } }] } };
  const md = mdNode({ selected: "r2" }, [{ key: "f1", form: { fields: [] } }, tabs]);

  it("childLists and withChildLists reach a detail and a tabs node's children", () => {
    expect(childLists(md)).toEqual([md.masterDetail?.detail]);
    expect(childLists(tabs)).toEqual([tabs.tabs?.children]);
    const replaced = withChildLists(md, [[{ key: "x", text: { content: "x" } }]]);
    expect(replaced.masterDetail?.detail.map((n) => n.key)).toEqual(["x"]);
    expect(replaced.masterDetail?.list).toBe(md.masterDetail?.list);
    expect(withChildLists(tabs, [[]]).tabs?.children).toEqual([]);
    expect(withChildLists(tabs, [[]]).tabs?.active).toBe("b");
  });

  it("scopes forms by the selected row and the active node tab", () => {
    expect(nodeScope(md)).toBe("\u0001md=r2");
    expect(nodeScope(tabs)).toBe("\u0001tb=b");
    expect(nodeScope(mdNode())).toBe("\u0001md=");
    expect(nodeScope({ key: "t", text: { content: "x" } })).toBe("");
    expect(formsOf([md]).map((f) => [f.key, f.scope])).toEqual([
      ["f1", "\u0001md=r2"],
      ["f2", "\u0001md=r2\u0001tb=b"],
    ]);
    const seen: string[] = [];
    walkScoped([md], (n, scope) => seen.push(`${n.key}${scope}`));
    expect(seen).toEqual(["md", "f1\u0001md=r2", "tb\u0001md=r2", "f2\u0001md=r2\u0001tb=b"]);
  });

  it("drops a scoped form's drafts on a new reset token", () => {
    const view = (token: string): PluginViewModel => ({ nodes: [mdNode({ selected: "r2" }, [{ key: "f1", form: { fields: [], resetToken: token } }])] });
    const dk = draftKeyOf("i", "\u0001md=r2", "f1");
    const first = reconcileResets({}, {}, "i", view("1"));
    expect(first.resetTokens[dk]).toBe("1");
    const next = reconcileResets({ [dk]: { note: "x" } }, first.resetTokens, "i", view("2"));
    expect(next.drafts[dk]).toBeUndefined();
  });

  it("reconciles a narrow master-detail's detail: token, selected not a row, another row, gone", () => {
    const dk = draftKeyOf("i", "", "md");
    const view = (over: Partial<MasterDetailData>): PluginViewModel => ({ nodes: [mdNode(over)] });
    const open = { [dk]: { token: "", selected: "" } };
    expect(reconcileDetails(open, "i", view({ selected: "" }))).toBe(open);
    expect(reconcileDetails(open, "i", view({ selected: "r2" }))[dk]).toEqual({ token: "", selected: "r2" });
    expect(reconcileDetails({ [dk]: { token: "", selected: "r2" } }, "i", view({ selected: "nope" }))[dk]).toBeUndefined();
    expect(reconcileDetails({ [dk]: { token: "", selected: "r2" } }, "i", view({ selected: "" }))[dk]).toBeUndefined();
    expect(reconcileDetails({ [dk]: { token: "", selected: "r2" } }, "i", view({ selected: "r2", resetToken: "1" }))[dk]).toBeUndefined();
    expect(reconcileDetails(open, "i", { nodes: [] })).toBe(open);
    // Inside a tabs node the key carries its scope.
    const scoped = draftKeyOf("i", "\u0001tb=a", "md");
    const inTabs: PluginViewModel = { nodes: [{ key: "tb", tabs: { items: [{ key: "a", label: "A" }, { key: "b", label: "B" }], active: "a", children: [mdNode({ selected: "zz" })] } }] };
    expect(reconcileDetails({ [scoped]: { token: "", selected: "r1" } }, "i", inTabs)[scoped]).toBeUndefined();
  });
});

describe("master-detail, narrow", () => {
  it("shows the list alone, the selected row marked, and no detail", () => {
    boxes.md = { top: 0, height: 0, width: 328 };
    inSurface(<NodeList nodes={[mdNode({ selected: "r2" }, [{ key: "d-thread", thread: { threadId: "s-1" } }])]} />);
    expect(root().getAttribute("data-layout")).toBe("narrow");
    expect(root().getAttribute("data-showing")).toBe("list");
    expect(screen.getAllByTestId("plugin-row")).toHaveLength(4);
    expect(row("r2").getAttribute("data-selected")).toBe("true");
    expect(row("r2").getAttribute("aria-current")).toBe("true");
    expect(row("r1").getAttribute("role")).toBe("button");
    expect(screen.queryByTestId("plugin-md-back")).toBeNull();
    // The hidden detail is not drawn, so its live nodes hold nothing.
    expect(screen.queryByTestId("plugin-thread")).toBeNull();
    expect(screen.queryByTestId("plugin-empty")).toBeNull();
  });

  it("choosing a row sends a select act, shows it selected meanwhile, then the detail with a back button", async () => {
    boxes.md = { top: 0, height: 0, width: 328 };
    const r = inSurface(<NodeList nodes={[mdNode()]} />);
    fireEvent.click(row("r2"));
    expect(acts.calls.map((c) => c.key)).toEqual(["r2"]);
    expect(root().getAttribute("data-selected")).toBe("r2");
    // Open, but the plugin has not said r2 yet: the pending row's detail (the old one) dims.
    expect(root().getAttribute("data-showing")).toBe("detail");
    expect(screen.getByTestId("plugin-md-back").textContent).toBe("Build #2");
    expect(document.activeElement).toBe(screen.getByTestId("plugin-md-back"));
    expect(screen.getByTestId("plugin-md-content").getAttribute("data-pending")).toBe("true");
    await settle(true);
    r.rerender(
      <ViewContext.Provider value={{ ...ctx, version: 2 }}>
        <SurfaceFrame top={null} toolbar={[]} footer={[]}>
          <NodeList nodes={[mdNode({ selected: "r2" })]} />
        </SurfaceFrame>
      </ViewContext.Provider>,
    );
    expect(root().getAttribute("data-showing")).toBe("detail");
    expect(screen.getByTestId("plugin-md-content").getAttribute("data-pending")).toBeNull();
    expect(screen.getByText("the detail")).toBeTruthy();
    fireEvent.click(screen.getByTestId("plugin-md-back"));
    expect(root().getAttribute("data-showing")).toBe("list");
    expect(usePluginSurfacesStore.getState().details[DK]).toBeUndefined();
    expect(document.activeElement).toBe(row("r2"));
    // Back sends nothing.
    expect(acts.calls).toHaveLength(1);
  });

  it("reverts the selection and goes back to the list when the act fails", async () => {
    boxes.md = { top: 0, height: 0, width: 328 };
    inSurface(<NodeList nodes={[mdNode({ selected: "r1" })]} />);
    fireEvent.click(row("r2"));
    expect(root().getAttribute("data-selected")).toBe("r2");
    expect(root().getAttribute("data-showing")).toBe("detail");
    await settle(false);
    expect(row("r1").getAttribute("data-selected")).toBe("true");
    expect(row("r2").getAttribute("data-selected")).toBeNull();
    expect(root().getAttribute("data-showing")).toBe("list");
  });

  it("opens the selected row without an act, and a row's own event action is its choice", () => {
    boxes.md = { top: 0, height: 0, width: 328 };
    inSurface(<NodeList nodes={[mdNode({ selected: "r1" })]} />);
    fireEvent.click(row("r1"));
    expect(acts.calls).toHaveLength(0);
    expect(root().getAttribute("data-showing")).toBe("detail");
    fireEvent.click(screen.getByTestId("plugin-md-back"));
    fireEvent.keyDown(row("r3"), { key: "Enter" });
    expect(acts.calls.map((c) => c.key)).toEqual(["r3"]);
    expect(root().getAttribute("data-selected")).toBe("r3");
    expect(screen.getByTestId("plugin-md-back").textContent).toBe("Build #3");
  });

  it("runs a host action row without choosing it", () => {
    boxes.md = { top: 0, height: 0, width: 328 };
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    inSurface(<NodeList nodes={[mdNode({ selected: "r1" })]} />);
    fireEvent.click(row("r4"));
    expect(acts.calls).toHaveLength(0);
    expect(root().getAttribute("data-showing")).toBe("list");
    expect(row("r1").getAttribute("data-selected")).toBe("true");
    open.mockRestore();
  });

  it("keeps showing the detail across a remount, per view tab", () => {
    boxes.md = { top: 0, height: 0, width: 328 };
    usePluginSurfacesStore.setState({ details: { [DK]: { token: "", selected: "r2" } } });
    const r = inSurface(<NodeList nodes={[mdNode({ selected: "r2" })]} />);
    expect(root().getAttribute("data-showing")).toBe("detail");
    r.unmount();
    inSurface(<NodeList nodes={[mdNode({ selected: "r2" })]} />, { viewTab: "other" });
    expect(root().getAttribute("data-showing")).toBe("list");
  });

  it("shows the list when the selected row is not a row any more (the store's reconcile)", () => {
    boxes.md = { top: 0, height: 0, width: 328 };
    usePluginSurfacesStore.setState({ details: { [DK]: { token: "", selected: "r2" } } });
    inSurface(<NodeList nodes={[mdNode({ selected: "" })]} />);
    expect(root().getAttribute("data-showing")).toBe("list");
  });

  it("goes back to the list on a new resetToken and stays on the detail when the plugin selects another row", () => {
    boxes.md = { top: 0, height: 0, width: 328 };
    usePluginSurfacesStore.setState({ details: { [DK]: { token: "1", selected: "r1" } } });
    const r = inSurface(<NodeList nodes={[mdNode({ selected: "r1", resetToken: "1" })]} />);
    expect(root().getAttribute("data-showing")).toBe("detail");
    const next = (over: Partial<MasterDetailData>) => {
      const view: PluginViewModel = { tabs: { items: [{ key: "run-list", label: "Runs" }], active: "run-list" }, nodes: [mdNode(over)] };
      act(() => {
        usePluginSurfacesStore.setState((s) => ({ details: reconcileDetails(s.details, INSTANCE, view) }));
      });
      r.rerender(
        <ViewContext.Provider value={ctx}>
          <SurfaceFrame top={null} toolbar={[]} footer={[]}>
            <NodeList nodes={view.nodes} />
          </SurfaceFrame>
        </ViewContext.Provider>,
      );
    };
    next({ selected: "r2", resetToken: "1" });
    expect(root().getAttribute("data-showing")).toBe("detail");
    expect(screen.getByTestId("plugin-md-back").textContent).toBe("Build #2");
    next({ selected: "r2", resetToken: "2" });
    expect(root().getAttribute("data-showing")).toBe("list");
    expect(row("r2").getAttribute("data-selected")).toBe("true");
  });

  it("does nothing while inert", () => {
    boxes.md = { top: 0, height: 0, width: 328 };
    inSurface(<NodeList nodes={[mdNode()]} />, { inert: true });
    fireEvent.click(row("r2"));
    expect(acts.calls).toHaveLength(0);
    expect(root().getAttribute("data-showing")).toBe("list");
    expect(row("r2").getAttribute("role")).toBeNull();
  });

  it("shows the list's empty text", () => {
    inSurface(<NodeList nodes={[{ key: "md", masterDetail: { list: { rows: [], emptyText: "No runs yet" }, detail: [] } }]} />);
    expect(screen.getByTestId("plugin-list-empty").textContent).toBe("No runs yet");
  });
});

describe("master-detail, wide", () => {
  it("puts the list at its width beside the detail from 612 px, follows resizes", () => {
    boxes.md = { top: 0, height: 0, width: 611 };
    inSurface(<NodeList nodes={[mdNode({ selected: "r1" })]} />);
    expect(root().getAttribute("data-layout")).toBe("narrow");
    boxes.md = { top: 0, height: 0, width: 612 };
    resize();
    expect(root().getAttribute("data-layout")).toBe("wide");
    expect(root().className).toContain("gap-3");
    const list = screen.getByTestId("plugin-md-list");
    expect(list.style.width).toBe(`${String(MASTER_DETAIL_LIST_WIDTH + 8)}px`);
    expect(list.className).toContain("overflow-y-auto");
    expect(screen.getByTestId("plugin-md-detail").className).toContain("overflow-y-auto");
    expect(screen.getByText("the detail")).toBeTruthy();
    expect(screen.queryByTestId("plugin-md-back")).toBeNull();
    boxes.md = { top: 0, height: 0, width: 400 };
    resize();
    expect(root().getAttribute("data-layout")).toBe("narrow");
  });

  it("takes a custom list width and shows the empty detail when nothing is selected", () => {
    boxes.md = { top: 0, height: 0, width: 560 };
    inSurface(<NodeList nodes={[mdNode({ listWidth: 220 })]} />);
    expect(root().getAttribute("data-layout")).toBe("wide");
    expect(screen.getByTestId("plugin-md-list").style.width).toBe("228px");
    expect(screen.getByTestId("plugin-empty").textContent).toContain("No run chosen");
    expect(screen.queryByText("the detail")).toBeNull();
  });

  it("is capped at the rest of its box below its top", () => {
    boxes["scroll-root"] = { top: 0, height: 700, width: 900 };
    boxes.md = { top: 100, height: 0, width: 900 };
    inSurface(<NodeList nodes={[mdNode({ selected: "r1" })]} />);
    resize();
    // 700 - 100 - the scroll area's 16 px bottom.
    expect(root().style.maxHeight).toBe("584px");
    boxes["scroll-root"] = { top: 0, height: 200, width: 900 };
    resize();
    expect(root().style.maxHeight).toBe(`${String(FILL_MIN)}px`);
  });

  it("chooses on click and dims the old detail until the plugin's next view after the act", async () => {
    boxes.md = { top: 0, height: 0, width: 900 };
    inSurface(<NodeList nodes={[mdNode({ selected: "r1" })]} />);
    fireEvent.click(row("r2"));
    expect(acts.calls.map((c) => c.key)).toEqual(["r2"]);
    expect(screen.getByTestId("plugin-md-content").className).toContain("opacity-60");
    await settle(true);
    // Answered, but the view the plugin sent with it has not come (the daemon coalesces views).
    expect(screen.getByTestId("plugin-md-content").className).toContain("opacity-60");
    expect(root().getAttribute("data-selected")).toBe("r2");
    act(() => {
      usePluginSurfacesStore.setState((s) => applyUpdateToState(s, "w", { kind: "view", instance: INSTANCE, version: 2, view: { nodes: [] }, hostRendered: false }));
    });
    expect(screen.getByTestId("plugin-md-content").className).not.toContain("opacity-60");
  });
});

function LeavingProbe() {
  const leaving = useLeavingViewTab("w");
  return <span data-testid="probe" data-leaving={leaving || undefined} />;
}

describe("live nodes", () => {
  it("let go inside a pending selection or tab switch, and an outer leave reaches inner nodes", () => {
    boxes.md = { top: 0, height: 0, width: 900 };
    const probeNode: ViewNode = { key: "probe-host", text: { content: "x" } };
    // The probe stands in for a thread node: it reads useLeavingViewTab like one.
    render(
      <LeavingNode.Provider value={true}>
        <LeavingProbe />
      </LeavingNode.Provider>,
    );
    expect(screen.getByTestId("probe").getAttribute("data-leaving")).toBe("true");
    cleanup();
    render(<LeavingProbe />);
    expect(screen.getByTestId("probe").getAttribute("data-leaving")).toBeNull();
    cleanup();
    // A terminal in a pending detail shows paused (no stream).
    usePluginSurfacesStore.setState({ choices: { w: { [DK]: { key: "r2", seq: 1, version: 1, answered: false } } } });
    inSurface(<NodeList nodes={[mdNode({ selected: "r1" }, [probeNode, { key: "d-term", terminal: { terminalId: "t-1" } }])]} />);
    expect(screen.getByTestId("plugin-md-content").getAttribute("data-pending")).toBe("true");
    expect(document.querySelector('[data-key="d-term"][data-live="true"]')).toBeNull();
  });
});

describe("tabs node", () => {
  const tabsNode = (active: string, children: ViewNode[] = []): ViewNode => ({
    key: "tb",
    tabs: { items: [{ key: "ta", label: "Overview" }, { key: "tl", label: "Log", badge: { label: "1 error", tone: "error" } }], active, children },
  });

  it("draws a smaller strip, the active tab raised, and its children", () => {
    inSurface(<NodeList nodes={[tabsNode("ta", [{ key: "c", text: { content: "overview body" } }])]} />);
    const strip = screen.getByTestId("plugin-node-tabs");
    expect(strip.querySelector('[role="tablist"]')?.className).toContain("rounded-md");
    const tabs = screen.getAllByTestId("plugin-node-tab");
    expect(tabs.map((t) => [t.getAttribute("data-key"), t.getAttribute("aria-selected")])).toEqual([
      ["ta", "true"],
      ["tl", "false"],
    ]);
    expect(tabs[0]?.className).toContain("h-5");
    expect(tabs[0]?.className).toContain("rounded-sm");
    expect(tabs[0]?.className).toContain("text-caption-sm");
    expect(tabs[1]?.textContent).toContain("1 error");
    expect(screen.getByTestId("plugin-tabs-panel").textContent).toBe("overview body");
    // Not the view's bar: no border, not pinned.
    expect(strip.className).not.toContain("border-b");
  });

  it("sends a tab act on another tab, reads it active while pending, and back when it fails", async () => {
    inSurface(<NodeList nodes={[tabsNode("ta")]} />);
    const log = () => screen.getAllByTestId("plugin-node-tab")[1];
    fireEvent.click(screen.getAllByTestId("plugin-node-tab")[0] as HTMLElement);
    expect(acts.calls).toHaveLength(0);
    fireEvent.click(log() as HTMLElement);
    expect(acts.calls.map((c) => c.key)).toEqual(["tl"]);
    expect(log()?.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("plugin-tabs-node").getAttribute("data-switching")).toBe("tl");
    await settle(false);
    expect(log()?.getAttribute("aria-selected")).toBe("false");
  });

  it("disables its tabs while inert", () => {
    inSurface(<NodeList nodes={[tabsNode("ta")]} />, { inert: true });
    expect(screen.getAllByTestId("plugin-node-tab").every((t) => (t as HTMLButtonElement).disabled)).toBe(true);
  });

  it("keeps a form's drafts per node tab and per selected row", () => {
    const form: ViewNode = { key: "note", form: { fields: [{ key: "n", name: "note", label: "Note", input: {} }] } };
    const view = (selected: string, active: string) => mdNode({ selected }, [tabsNode(active, active === "ta" ? [form] : [])]);
    boxes.md = { top: 0, height: 0, width: 900 };
    const r = inSurface(<NodeList nodes={[view("r1", "ta")]} />);
    fireEvent.change(screen.getByTestId("plugin-input"), { target: { value: "flaky" } });
    const key = draftKeyOf(INSTANCE, "run-list\u0001md=r1\u0001tb=ta", "note");
    expect(usePluginSurfacesStore.getState().drafts[key]).toEqual({ note: "flaky" });
    const again = (selected: string, active: string) => {
      r.rerender(
        <ViewContext.Provider value={ctx}>
          <SurfaceFrame top={null} toolbar={[]} footer={[]}>
            <NodeList nodes={[view(selected, active)]} />
          </SurfaceFrame>
        </ViewContext.Provider>,
      );
    };
    again("r1", "tl");
    expect(screen.queryByTestId("plugin-input")).toBeNull();
    again("r1", "ta");
    expect(screen.getByTestId<HTMLInputElement>("plugin-input").value).toBe("flaky");
    again("r2", "ta");
    expect(screen.getByTestId<HTMLInputElement>("plugin-input").value).toBe("");
  });
});

describe("the demo's Runs tab", () => {
  it("renders the captured master-detail: six runs, nothing chosen", () => {
    inSurface(<NodeList nodes={demoView("run-list").nodes} />);
    expect(root().getAttribute("data-layout")).toBe("narrow");
    expect(screen.getAllByTestId("plugin-row").map((r) => r.getAttribute("data-key"))).toEqual(["runs-run-6", "runs-run-5", "runs-run-4", "runs-run-3", "runs-run-2", "runs-run-1"]);
    expect(root().getAttribute("data-selected")).toBeNull();
  });
});
