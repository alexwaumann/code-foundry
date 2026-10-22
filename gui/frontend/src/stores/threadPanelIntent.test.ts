import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView, WorktreeView } from "@/api/project";
import type { ThreadView } from "@/api/threads";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { info: vi.fn(), error: vi.fn(), warning: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/api/app", () => ({ playAlertSound: vi.fn(() => Promise.resolve()) }));

const { applyIntent, clearPendingFocus } = await import("./intents");
const { getPanel, makeTab, usePanelStore } = await import("./panel");
const { useProjectsStore } = await import("./projects");
const { showThreadView } = await import("./threadPanelIntent");
const { useThreadsStore } = await import("./threads");
const { useUiStore } = await import("./ui");
const { useViewsStore } = await import("./views");

const WEB_MAIN = "/src/web";
const WEB_FEAT = "/wt/web/cf-feat";
const status = { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null };
const wt = (path: string, branch: string, isMain = false): WorktreeView => ({ projectId: "web", path, branch, head: "abc", detached: false, isMain, status });
const web: ProjectView = { id: "web", path: WEB_MAIN, name: "web", defaultBranch: "main", githubSlug: "", remotes: [], git: true, worktrees: [wt(WEB_MAIN, "main", true), wt(WEB_FEAT, "cf/feat")] };
const thread = (id: string, o: Partial<ThreadView> = {}) =>
  ({ id, projectId: "web", worktreePath: WEB_MAIN, workspaceId: "", pendingWorktreePath: "", state: "connected", linkedPullRequests: [], agentRuns: [], createdAtMs: 1, ...o }) as unknown as ThreadView;

/** The user is in thread "a" (its prompt focused); the model works in thread "b". */
const inA = { kind: "thread", id: "a" } as const;
const show = (name: string, threadId?: string) => {
  applyIntent(threadId ? { kind: "showView", name, threadId } : { kind: "showView", name });
};
const tabIds = (key: string) => getPanel(key).groups.flatMap((g) => g.tabs.map((t) => t.id));

beforeEach(() => {
  vi.clearAllMocks();
  clearPendingFocus();
  usePanelStore.setState({ byKey: {} });
  useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
  useProjectsStore.setState({ byId: { web }, order: ["web"] });
  useThreadsStore.setState({
    byId: { a: thread("a"), b: thread("b", { worktreePath: WEB_FEAT }), home: thread("home", { projectId: "", worktreePath: "/Users/me" }) },
    order: ["a", "b", "home"],
  });
  useUiStore.setState({ selection: inA, focus: "content", panelFocusSeq: 0, promptFocusSeq: 0 });
});

describe("a ShowView scoped to a thread", () => {
  it.each([
    ["panel.usage", "usage"],
    ["panel.mcp", "mcp"],
    ["panel.worktree", `worktree?path=${encodeURIComponent(WEB_FEAT)}&project=web`],
  ])("%s opens the tab in that thread's panel and leaves the selection and focus alone", (name, tab) => {
    show(name, "b");
    expect(useUiStore.getState().selection).toEqual(inA);
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
    expect(getPanel("thread:b").open).toBe(true);
    expect(tabIds("thread:b")).toEqual([tab]);
    expect(getPanel("thread:a")).toEqual(getPanel("thread:never"));
  });

  it("on the selected thread shows the change at once, still without taking focus", () => {
    show("panel.usage", "a");
    expect(getPanel().open).toBe(true);
    expect(tabIds("thread:a")).toEqual(["usage"]);
    expect(useUiStore.getState().panelFocusSeq).toBe(0);
    expect(useUiStore.getState().focus).toBe("content");
  });

  it("is there when the user opens the thread", () => {
    show("panel.usage", "b");
    useUiStore.getState().select({ kind: "thread", id: "b" });
    expect(getPanel().open).toBe(true);
    expect(tabIds("thread:b")).toEqual(["usage"]);
  });

  it("applies while the settings page is up, which stays", () => {
    useViewsStore.setState({ settingsOpen: true });
    show("panel.usage", "b");
    expect(getPanel("thread:b").open).toBe(true);
    expect(useViewsStore.getState().settingsOpen).toBe(true);
  });

  it("a surface the thread cannot show changes nothing and says nothing", () => {
    expect(showThreadView("panel.worktree", "home")).toBe(false); // in no worktree
    expect(showThreadView("panel.workspace", "b")).toBe(false); // in no workspace
    expect(showThreadView("panel.linked-prs", "b")).toBe(false); // no linked pull requests
    expect(showThreadView("panel.agents", "b")).toBe(false); // no subagent runs
    expect(usePanelStore.getState().byKey).toEqual({});
    expect(toast).not.toHaveBeenCalled();
    expect(toast.info).not.toHaveBeenCalled();
  });

  it("a thread the window does not know, or a name that is no panel action, changes nothing", () => {
    expect(showThreadView("panel.usage", "zz")).toBe(false);
    expect(showThreadView("settings", "b")).toBe(false);
    show("settings", "b");
    show("dashboard", "b");
    expect(useViewsStore.getState().settingsOpen).toBe(false);
    expect(useUiStore.getState().selection).toEqual(inA);
    expect(usePanelStore.getState().byKey).toEqual({});
  });

  describe("the panel actions", () => {
    const usage = makeTab("usage", "Usage");
    const mcp = makeTab("mcp", "MCP");
    beforeEach(() => {
      usePanelStore.setState({ byKey: { "thread:b": { open: false, groups: [{ tabs: [usage, mcp], activeTabId: usage.id }] } } });
    });

    it("panel.toggle shows, then hides the thread's panel", () => {
      show("panel.toggle", "b");
      expect(getPanel("thread:b").open).toBe(true);
      show("panel.toggle", "b");
      expect(getPanel("thread:b").open).toBe(false);
    });

    it("panel.expand shows a hidden panel expanded, then restores the split", () => {
      show("panel.expand", "b");
      expect(getPanel("thread:b")).toMatchObject({ open: true, expanded: true });
      show("panel.expand", "b");
      expect(getPanel("thread:b").expanded).toBeUndefined();
    });

    it("panel.new-tab shows the surface list", () => {
      show("panel.new-tab", "b");
      expect(getPanel("thread:b")).toMatchObject({ open: true, groups: [{ activeTabId: null, pickFrom: usage.id }] });
    });

    it("panel.split splits a hidden panel, shown; then joins it", () => {
      show("panel.split", "b");
      expect(getPanel("thread:b").open).toBe(true);
      expect(getPanel("thread:b").groups).toHaveLength(2);
      show("panel.split", "b");
      expect(getPanel("thread:b").groups).toHaveLength(1);
    });

    it("none of them moves the selection, focus or another thread's panel", () => {
      for (const name of ["panel.toggle", "panel.expand", "panel.new-tab", "panel.split"]) show(name, "b");
      expect(useUiStore.getState().selection).toEqual(inA);
      expect(useUiStore.getState().panelFocusSeq).toBe(0);
      expect(Object.keys(usePanelStore.getState().byKey)).toEqual(["thread:b"]);
    });
  });

  it("without a thread id it acts on the selection as before, and takes focus", () => {
    show("panel.usage");
    expect(tabIds("thread:a")).toEqual(["usage"]);
    expect(useUiStore.getState().panelFocusSeq).toBe(1);
  });

  it("--focus: the focusThread before it selects the thread, then its panel opens", () => {
    applyIntent({ kind: "focusThread", threadId: "b" });
    show("panel.usage", "b");
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "b" });
    expect(getPanel().open).toBe(true);
    expect(tabIds("thread:b")).toEqual(["usage"]);
  });

  it("does not drop a pending focusThread", () => {
    applyIntent({ kind: "focusThread", threadId: "late" });
    show("panel.usage", "b");
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, late: thread("late", { createdAtMs: null }) }, order: [...s.order, "late"] }));
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "late" });
  });
});
