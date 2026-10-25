import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectView, WorktreeView } from "@/api/project";
import type { ThreadView } from "@/api/threads";
import type { TerminalView } from "@/api/terminal";

// The tab body reads the branch's pull requests; nothing to fetch here.
const getBranchPullRequests = vi.hoisted(() => vi.fn(() => Promise.resolve({ pullRequests: [], fetchedAtMs: 1, lastError: "" })));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), getBranchPullRequests }));

const { SidePanel } = await import("@/components/panel/SidePanel");
const { getPanel, usePanelStore } = await import("@/stores/panel");
const { useProjectsStore } = await import("@/stores/projects");
const { useThreadsStore } = await import("@/stores/threads");
const { useTerminalsStore } = await import("@/stores/terminals");
const { useUiStore } = await import("@/stores/ui");
const { showView, useViewsStore, worktreePanelCommand } = await import("@/stores/views");
const { showWorktreeInPanel, worktreeTabTitle } = await import("@/stores/worktreePanel");

const WEB_MAIN = "/src/web";
const WEB_FEAT = "/wt/web/cf-feat";
const status = { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null };
const wt = (projectId: string, path: string, branch: string, isMain = false): WorktreeView => ({ projectId, path, branch, head: "abc", detached: false, isMain, status });
const project = (id: string, extra: WorktreeView[] = []): ProjectView => ({ id, path: `/src/${id}`, name: id, defaultBranch: "main", githubSlug: "", remotes: [], git: true, worktrees: [wt(id, `/src/${id}`, "main", true), ...extra] });
const thread = (id: string, o: Partial<ThreadView>) => ({ id, projectId: "web", worktreePath: WEB_MAIN, workspaceId: "", projectIds: ["web"], branch: "", pendingWorktreePath: "", terminalId: "", state: "connected", linkedPullRequests: [], agentRuns: [], ...o }) as unknown as ThreadView;

function select(id: string): void {
  useUiStore.setState({ selection: { kind: "thread", id } });
}

beforeEach(() => {
  useProjectsStore.setState({ byId: { web: project("web", [wt("web", WEB_FEAT, "cf/feat")]) }, order: ["web"] });
  useThreadsStore.setState({
    byId: {
      "s-main": thread("s-main", {}),
      "s-feat": thread("s-feat", { worktreePath: WEB_FEAT }),
      "s-sub": thread("s-sub", { worktreePath: `${WEB_FEAT}/src` }),
      "s-lost": thread("s-lost", { projectId: "", worktreePath: "/elsewhere" }),
    },
    order: ["s-main", "s-feat", "s-sub", "s-lost"],
  });
  useTerminalsStore.setState({ byId: {}, order: [] });
  const open = { open: true, groups: [{ tabs: [], activeTabId: null }] };
  usePanelStore.setState({ byKey: { "thread:s-main": open, "thread:s-feat": open, "thread:s-sub": open, "view:projects": open } });
  useViewsStore.setState({ settingsOpen: false });
  useUiStore.setState({ windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260, palette: { ...useUiStore.getState().palette, open: false } });
  select("s-feat");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const row = () => screen.queryByTestId("panel-empty")?.querySelector('[data-surface="worktree"]') ?? null;

describe("worktreeTabTitle", () => {
  it("is the project for the main worktree, project · branch elsewhere, the project for an unknown path", () => {
    const projects = useProjectsStore.getState();
    expect(worktreeTabTitle(projects, "web", WEB_MAIN)).toBe("web");
    expect(worktreeTabTitle(projects, "web", WEB_FEAT)).toBe("web · cf/feat");
    expect(worktreeTabTitle(projects, "web", "/gone")).toBe("web");
    expect(worktreeTabTitle(projects, "nope", "/x")).toBe("nope");
  });
});

describe("Worktree surface availability", () => {
  it("is listed with T for a thread in a worktree and hidden for a thread outside any", () => {
    render(<SidePanel />);
    expect(row()?.getAttribute("data-availability")).toBe("enabled");
    expect(row()?.textContent).toContain("Worktree");
    expect(row()?.textContent).toContain("T");
    act(() => {
      useUiStore.setState({ selection: { kind: "thread", id: "s-lost" } });
    });
    expect(row()).toBeNull();
  });

  it("is hidden on a page", () => {
    render(<SidePanel />);
    expect(row()?.getAttribute("data-availability")).toBe("enabled");
    act(() => {
      useUiStore.setState({ selection: { kind: "view", name: "projects" } });
    });
    expect(row()).toBeNull();
  });

  it("T opens the thread's own worktree: title with the branch, the overview body", () => {
    render(<SidePanel />);
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "t" });
    const p = getPanel("thread:s-feat");
    expect(p.groups[0]?.activeTabId).toBe(`worktree?path=${encodeURIComponent(WEB_FEAT)}&project=web`);
    expect(p.groups[0]?.tabs[0]?.title).toBe("web · cf/feat");
    expect(screen.getByTestId("worktree-surface").getAttribute("data-path")).toBe(WEB_FEAT);
    expect(screen.getByTestId("worktree-surface-title").textContent).toBe("web@cf/feat");
  });

  it("the tab's who-else line counts the worktree's other threads and shells, not the thread it is open for", () => {
    useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-feat2": thread("s-feat2", { worktreePath: WEB_FEAT }) }, order: [...s.order, "s-feat2"] }));
    useTerminalsStore.setState({ byId: { t1: { id: "t1", cwd: WEB_FEAT, state: "running" } as TerminalView }, order: ["t1"] });
    render(<SidePanel />);
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "t" });
    expect(screen.getByTestId("worktree-who").textContent).toBe("1 other thread1 shell");
    act(() => {
      useTerminalsStore.setState({ byId: {}, order: [] });
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, "s-feat2": { ...thread("s-feat2", { worktreePath: WEB_FEAT }), archivedAtMs: 1 } } }));
    });
    expect(screen.queryByTestId("worktree-who")).toBeNull();
  });

  it("a thread's tab follows its placement (the worktree, not the folder inside it)", () => {
    select("s-sub");
    render(<SidePanel />);
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "t" });
    expect(getPanel("thread:s-sub").groups[0]?.tabs[0]?.params).toEqual({ project: "web", path: WEB_FEAT });
  });
});

describe("worktreePanelCommand (view.panel.worktree)", () => {
  it("opens the tab and shows a hidden panel for a thread on the main worktree", () => {
    usePanelStore.setState({ byKey: {} });
    select("s-main");
    expect(worktreePanelCommand()).toBe(true);
    expect(getPanel("thread:s-main")).toMatchObject({ open: true, groups: [{ activeTabId: `worktree?path=${encodeURIComponent(WEB_MAIN)}&project=web` }] });
    expect(getPanel("thread:s-main").groups[0]?.tabs[0]?.title).toBe("web");
  });

  it("does nothing for a thread outside any worktree, on a page, or under the settings page", () => {
    usePanelStore.setState({ byKey: {} });
    select("s-lost");
    expect(worktreePanelCommand()).toBe(false);
    expect(getPanel("thread:s-lost").open).toBe(false);
    useUiStore.setState({ selection: { kind: "view", name: "projects" } });
    expect(worktreePanelCommand()).toBe(false);
    expect(getPanel("view:projects").open).toBe(false);
    select("s-feat");
    useViewsStore.setState({ settingsOpen: true });
    expect(worktreePanelCommand()).toBe(false);
    expect(getPanel("thread:s-feat").open).toBe(false);
  });

  it("is reached through ShowView panel.worktree and, from the palette, returns focus to the panel", () => {
    usePanelStore.setState({ byKey: {} });
    useUiStore.setState((s) => ({ palette: { ...s.palette, open: true, returnTo: "content" } }));
    expect(showView("panel.worktree")).toBe(true);
    expect(getPanel("thread:s-feat").open).toBe(true);
    expect(useUiStore.getState().palette.returnTo).toBe("panel");
  });
});

describe("showWorktreeInPanel (the Projects page's rows)", () => {
  it("opens the tab in the page's own panel and shows it; the same worktree twice is one tab", () => {
    usePanelStore.setState({ byKey: {} });
    useUiStore.setState({ selection: { kind: "view", name: "projects" } });
    const seq = useUiStore.getState().panelFocusSeq;
    expect(showWorktreeInPanel("web", WEB_MAIN)).toBe(true);
    expect(showWorktreeInPanel("web", WEB_FEAT)).toBe(true);
    expect(showWorktreeInPanel("web", WEB_MAIN)).toBe(true);
    const p = getPanel("view:projects");
    expect(p.open).toBe(true);
    expect(p.groups[0]?.tabs.map((t) => t.title)).toEqual(["web", "web · cf/feat"]);
    expect(p.groups[0]?.activeTabId).toBe(p.groups[0]?.tabs[0]?.id);
    // The list keeps the keyboard: no focus request.
    expect(useUiStore.getState().panelFocusSeq).toBe(seq);
  });

  it("does nothing with nothing selected", () => {
    usePanelStore.setState({ byKey: {} });
    useUiStore.setState({ selection: { kind: "none" } });
    expect(showWorktreeInPanel("web", WEB_MAIN)).toBe(false);
    expect(usePanelStore.getState().byKey).toEqual({});
  });
});
