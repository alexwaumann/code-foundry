import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LayoutApplyView, LayoutOpView } from "@/api/layout";
import { layoutOf, pane, row, seedLayout, space, tab } from "@/test/shellLayout";

const applyLayoutOp = vi.fn<(op: LayoutOpView) => Promise<LayoutApplyView>>();
vi.mock("@/api/layout", async (orig) => ({ ...(await orig<typeof import("@/api/layout")>()), applyLayoutOp: (op: LayoutOpView) => applyLayoutOp(op) }));
const runLayoutCommand = vi.fn<(name: string, args: Record<string, string>) => Promise<{ rev: number; changed: boolean; tab?: string } | null>>();
vi.mock("@/shell/commands", () => ({
  runLayoutCommand: (name: string, args: Record<string, string>) => runLayoutCommand(name, args),
  focusTabNow: (id: string) => runLayoutCommand("tab.focus", { tab: id, focus: "true" }),
  afterRev: () => Promise.resolve(),
}));

const { composeParamsOf, composeSelectionOf, focusedTab, planRoute, selectionOfTab, startSelectionBridge } = await import("./selectionBridge");
const { resetLayout, useLayoutStore } = await import("./layout");
const { HOME, useUiStore } = await import("./ui");

const none = () => ({ likeProject: "", firstMember: "" });

describe("the selection of each tab kind", () => {
  it.each([
    ["a thread's tab: the thread", tab("t-1", "thread", "s-1"), { kind: "thread", id: "s-1" }],
    ["a diff linked to a thread: that thread", tab("t-2", "diff", "s-1"), { kind: "thread", id: "s-1" }],
    ["a file linked to a thread: that thread", tab("t-3", "file", "s-2"), { kind: "thread", id: "s-2" }],
    ["Ember's board: Ember's thread", tab("t-4", "ember.board", "s-e"), { kind: "thread", id: "s-e" }],
    ["Pull Requests: the page", tab("t-5", "prs"), { kind: "view", name: "pullrequests" }],
    ["Projects: the index", tab("t-6", "projects"), { kind: "view", name: "projects" }],
    ["Projects on a project's page", tab("t-7", "projects", "", { params: { project: "pj" } }), { kind: "view", name: "projects", projectId: "pj" }],
    ["Projects on a workspace's page", tab("t-8", "projects", "", { params: { workspace: "ws" } }), { kind: "view", name: "projects", workspaceId: "ws" }],
    ["the empty composer: home", tab("t-9", "compose"), HOME],
    ["a project's composer", tab("t-10", "compose", "", { params: { project: "pj" } }), { kind: "compose", projectId: "pj" }],
    ["an unlinked diff (from Projects): none", tab("t-11", "diff"), { kind: "none" }],
    ["a plugin surface linked to nothing: none", tab("t-12", "plugin.hello.demo"), { kind: "none" }],
  ])("%s", (_name, t, want) => {
    expect(selectionOfTab({ ...t, paneId: "p" }, none)).toEqual(want);
  });

  it("no tab (a space with no pane) is home", () => {
    expect(selectionOfTab(null)).toEqual(HOME);
  });

  it("a composer's params and its selection go both ways", () => {
    const look = { likeProject: "pl", firstMember: "pw" };
    const all: Record<string, string>[] = [{}, { project: "pj" }, { workspace: "ws" }, { like: "s-3" }];
    for (const params of all) {
      expect(composeParamsOf(composeSelectionOf(params, look))).toEqual(params);
    }
    expect(composeSelectionOf({ like: "s-3" }, look)).toEqual({ kind: "compose", projectId: "pl", likeThreadId: "s-3" });
    expect(composeSelectionOf({ workspace: "ws" }, look)).toEqual({ kind: "compose", projectId: "pw", workspaceId: "ws" });
  });
});

describe("routing a selection", () => {
  const grid = layoutOf([
    space(
      row("s-r", [
        pane("p-1", [tab("t-s1", "thread", "s-1"), tab("t-c", "compose")], "t-s1"),
        pane("p-2", [tab("t-d", "diff", "s-1"), tab("t-prs", "prs"), tab("t-pj", "projects", "", { params: { project: "pj" } })], "t-d"),
      ]),
      "p-1",
    ),
  ]);
  const focusOn = (paneId: string, tabId: string) => {
    const l = structuredClone(grid);
    const sp = l.spaces[0];
    if (!sp?.root || sp.root.t !== "split") throw new Error("fixture");
    sp.focus = paneId;
    sp.root = { ...sp.root, kids: sp.root.kids.map((k) => (k.t === "pane" && k.id === paneId ? { ...k, active: tabId } : k)) };
    return l;
  };

  beforeEach(() => {
    resetLayout();
  });

  it("a thread opens its tab with thread.open, or stays when it is the focused tab", async () => {
    await seedLayout(grid);
    const s = useLayoutStore.getState();
    expect(planRoute({ kind: "thread", id: "s-1" }, s)).toEqual({ kind: "stay" });
    expect(planRoute({ kind: "thread", id: "s-2" }, s)).toEqual({ kind: "command", name: "thread.open", args: { id: "s-2", focus: "true" } });
  });

  it("a thread selected while a composer has the focus opens beside it: only a send's --compose replaces a composer", async () => {
    await seedLayout(focusOn("p-1", "t-c"));
    const s = useLayoutStore.getState();
    expect(focusedTab(s)?.id).toBe("t-c");
    expect(planRoute({ kind: "thread", id: "s-9" }, s, { focusPrompt: true })).toEqual({ kind: "command", name: "thread.open", args: { id: "s-9", focus: "true" } });
  });

  it("Pull Requests focuses the space's tab, or opens one", async () => {
    await seedLayout(grid);
    expect(planRoute({ kind: "view", name: "pullrequests" }, useLayoutStore.getState())).toEqual({ kind: "focus", tab: "t-prs" });
    await seedLayout(layoutOf([space(pane("p-1", [tab("t-s1", "thread", "s-1")]), "p-1")], 2));
    expect(planRoute({ kind: "view", name: "pullrequests" }, useLayoutStore.getState())).toEqual({ kind: "open", tabKind: "prs", params: {} });
  });

  it("a Projects page moves the focused Projects tab, or focuses the space's and moves it", async () => {
    await seedLayout(focusOn("p-2", "t-pj"));
    const s = useLayoutStore.getState();
    expect(planRoute({ kind: "view", name: "projects", projectId: "pj" }, s)).toEqual({ kind: "stay" });
    expect(planRoute({ kind: "view", name: "projects" }, s)).toEqual({ kind: "params", tab: "t-pj", params: {} });
    await seedLayout(grid);
    expect(planRoute({ kind: "view", name: "projects", workspaceId: "ws" }, useLayoutStore.getState())).toEqual({ kind: "focus", tab: "t-pj", params: { workspace: "ws" } });
  });

  it("the composer opens with composer.new for what was picked; the empty space's home composer stays", async () => {
    await seedLayout(grid);
    expect(planRoute({ kind: "compose", projectId: "pj" }, useLayoutStore.getState())).toEqual({ kind: "command", name: "composer.new", args: { project: "pj", focus: "true" }, params: { project: "pj" } });
    await seedLayout(layoutOf([space(null, "")], 2));
    expect(planRoute(HOME, useLayoutStore.getState())).toEqual({ kind: "stay" });
    expect(planRoute({ kind: "none" }, useLayoutStore.getState())).toEqual({ kind: "stay" });
  });

  it("Ember's page is Ember's thread; an unknown page is not the shell's", async () => {
    await seedLayout(grid);
    const s = useLayoutStore.getState();
    expect(planRoute({ kind: "view", name: "ember" }, s, {}, "s-e")).toEqual({ kind: "command", name: "thread.open", args: { id: "s-e", focus: "true" } });
    expect(planRoute({ kind: "view", name: "nope" }, s)).toEqual({ kind: "none" });
  });
});

describe("the bridge", () => {
  let stop: () => void = () => undefined;
  beforeEach(() => {
    resetLayout();
    applyLayoutOp.mockReset();
    runLayoutCommand.mockReset();
    useUiStore.setState({ selection: HOME });
  });
  afterEach(() => {
    stop();
  });

  it("mirrors the focused tab into the selection, and select() goes to the layout", async () => {
    await seedLayout(layoutOf([space(row("s-r", [pane("p-1", [tab("t-s1", "thread", "s-1")]), pane("p-2", [tab("t-prs", "prs")])]), "p-1")]));
    stop = startSelectionBridge();
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-1" });

    runLayoutCommand.mockResolvedValue({ rev: 2, changed: true });
    useUiStore.getState().select({ kind: "thread", id: "s-4" }, { focusPrompt: true });
    // Shown at once; the layout follows.
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-4" });
    expect(runLayoutCommand).toHaveBeenCalledWith("thread.open", { id: "s-4", focus: "true" });

    // The daemon's answer focuses the Pull Requests pane: the selection follows it.
    await vi.waitFor(() => {
      expect(runLayoutCommand).toHaveBeenCalledTimes(1);
    });
    await seedLayout(layoutOf([space(row("s-r", [pane("p-1", [tab("t-s1", "thread", "s-1")]), pane("p-2", [tab("t-prs", "prs")])]), "p-2")], 3));
    await vi.waitFor(() => {
      expect(useUiStore.getState().selection).toEqual({ kind: "view", name: "pullrequests" });
    });
  });

  it("a select() asking for the prompt moves the keyboard into the focused pane once the opened tab is in the layout", async () => {
    const { useShellViewStore } = await import("./shellView");
    await seedLayout(layoutOf([space(pane("p-1", [tab("t-s1", "thread", "s-1")]), "p-1")]));
    stop = startSelectionBridge();
    const before = useShellViewStore.getState().focusRequest.seq;
    runLayoutCommand.mockResolvedValue({ rev: 2, changed: true, tab: "t-s4" });
    useUiStore.getState().select({ kind: "thread", id: "s-4" }, { focusPrompt: true });
    await vi.waitFor(() => {
      expect(useShellViewStore.getState().focusRequest).toEqual({ paneId: "p-1", seq: before + 1 });
    });
  });

  it("without a layout (an older daemon) select() is the store's", () => {
    stop = startSelectionBridge();
    useUiStore.getState().select({ kind: "thread", id: "s-4" });
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-4" });
    expect(runLayoutCommand).not.toHaveBeenCalled();
  });

  it("a thread selected before the shell first drew (a click while the import ran) opens when it does", async () => {
    // The sidebar is up before the pane grid: the click selects the thread the store's way.
    useUiStore.getState().select({ kind: "thread", id: "s-4" });
    await seedLayout(layoutOf([space(null, "")]));
    runLayoutCommand.mockResolvedValue({ rev: 2, changed: true });
    stop = startSelectionBridge();
    expect(runLayoutCommand).toHaveBeenCalledWith("thread.open", { id: "s-4", focus: "true" });
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-4" });
  });

  it("with nothing selected before, the first draw opens no thread: the selection follows the empty space", async () => {
    await seedLayout(layoutOf([space(null, "")]));
    stop = startSelectionBridge();
    expect(runLayoutCommand).not.toHaveBeenCalled();
    expect(useUiStore.getState().selection).toEqual(HOME);
  });

  it("a stopped bridge leaves select() to the store", async () => {
    await seedLayout(layoutOf([space(pane("p-1", [tab("t-s1", "thread", "s-1")]), "p-1")]));
    startSelectionBridge()();
    useUiStore.getState().select({ kind: "thread", id: "s-4" });
    expect(runLayoutCommand).not.toHaveBeenCalled();
  });
});
