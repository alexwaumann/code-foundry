import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RepoView, WorktreeView } from "@/api/repo";
import type { SessionView } from "@/api/session";
import type { WorkspaceView } from "@/api/workspace";

// The surface body's member rows read branch pull requests; nothing to fetch here.
const getBranchPullRequests = vi.hoisted(() => vi.fn(() => Promise.resolve({ pullRequests: [], fetchedAtMs: 1, lastError: "" })));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), getBranchPullRequests }));

const { SidePanel } = await import("@/components/panel/SidePanel");
const { getPanel, usePanelStore } = await import("@/stores/panel");
const { useReposStore } = await import("@/stores/repos");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");
const { useViewsStore, workspacePanelCommand } = await import("@/stores/views");
const { useWorkspacesStore } = await import("@/stores/workspaces");

const WEB = "/wt/web/cf-demo";
const API = "/wt/api/cf-demo";
const status = { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null };
const wt = (repoId: string, path: string, branch: string, isMain = false): WorktreeView => ({ repoId, path, branch, head: "abc", detached: false, isMain, status });
const repo = (id: string, extra: WorktreeView[] = []): RepoView => ({ id, path: `/src/${id}`, name: id, defaultBranch: "main", githubSlug: "", remotes: [], worktrees: [wt(id, `/src/${id}`, "main", true), ...extra] });
const ws: WorkspaceView = { id: "w1", name: "demo", branch: "cf/demo", members: [{ repoId: "web", worktreePath: WEB }, { repoId: "api", worktreePath: API }], createdAtMs: null };
const thread = (id: string, o: Partial<SessionView>) => ({ id, repoId: "web", worktreePath: WEB, workspaceId: "", pendingWorktreePath: "", terminalId: "", state: "connected", ...o }) as SessionView;

function select(id: string): void {
  useUiStore.setState({ selection: { kind: "session", id } });
}

beforeEach(() => {
  useReposStore.setState({ byId: { web: repo("web", [wt("web", WEB, "cf/demo")]), api: repo("api", [wt("api", API, "cf/demo")]) }, order: ["api", "web"] });
  useSessionsStore.setState({ byId: { "s-ws": thread("s-ws", { workspaceId: "w1", worktreePath: API, repoId: "api" }), "s-proj": thread("s-proj", { repoId: "web", worktreePath: "/src/web" }) }, order: ["s-ws", "s-proj"] });
  useWorkspacesStore.setState({ byId: { w1: ws }, order: ["w1"], loaded: true });
  usePanelStore.setState({ byKey: { "session:s-ws": { open: true, tabs: [], activeTabId: null }, "session:s-proj": { open: true, tabs: [], activeTabId: null } } });
  useViewsStore.setState({ settingsOpen: false });
  useUiStore.setState({ windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260, palette: { ...useUiStore.getState().palette, open: false } });
  select("s-ws");
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const row = () => screen.queryByTestId("panel-empty")?.querySelector('[data-surface="workspace"]') ?? null;

describe("Workspace surface availability", () => {
  it("is listed with its W hotkey for a workspace thread and absent for a project thread", () => {
    render(<SidePanel />);
    expect(row()?.getAttribute("data-availability")).toBe("enabled");
    expect(row()?.textContent).toContain("W");
    // The member tab surface (worktree) is never listed.
    expect(screen.getByTestId("panel-empty").querySelector('[data-surface="worktree"]')).toBeNull();
    act(() => {
      select("s-proj");
    });
    expect(row()).toBeNull();
  });

  it("follows the thread: a project thread that is not in the workspace never shows it, an owned one does", () => {
    select("s-proj");
    render(<SidePanel />);
    expect(row()).toBeNull();
    act(() => {
      useSessionsStore.setState((s) => ({ byId: { ...s.byId, "s-proj": thread("s-proj", { repoId: "web", worktreePath: "/src/web", workspaceId: "w1" }) } }));
    });
    expect(row()?.getAttribute("data-availability")).toBe("enabled");
  });

  it("W opens the workspace tab: name, branch, members, the thread's member marked", () => {
    render(<SidePanel />);
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "w" });
    expect(getPanel("session:s-ws").activeTabId).toBe("workspace?workspace=w1");
    expect(screen.getByTestId("workspace-surface-name").textContent).toBe("demo");
    expect(screen.getByTestId("workspace-surface-branch").textContent).toBe("cf/demo");
    expect(screen.getByTestId("workspace-surface-count").textContent).toBe("2 members");
    const members = screen.getAllByTestId("workspace-member");
    expect(members.map((m) => m.getAttribute("data-repo"))).toEqual(["web", "api"]);
    expect(members.map((m) => m.getAttribute("data-current"))).toEqual([null, "true"]);
    // Run in is offered on the other member only.
    expect(members[0]?.querySelector('[data-testid="member-run-in"]')).not.toBeNull();
    expect(members[1]?.querySelector('[data-testid="member-run-in"]')).toBeNull();
  });

  it("a member opens as a worktree tab of the same panel", () => {
    render(<SidePanel />);
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "w" });
    const open = screen.getAllByTestId("member-open")[0];
    if (!open) throw new Error("no open button");
    fireEvent.click(open);
    const p = getPanel("session:s-ws");
    expect(p.tabs.map((t) => t.kind)).toEqual(["workspace", "worktree"]);
    expect(p.tabs[1]?.title).toBe("web");
    expect(screen.getByTestId("worktree-surface").getAttribute("data-path")).toBe(WEB);
    expect(screen.getByTestId("worktree-surface-title").textContent).toBe("web@cf/demo");
  });
});

describe("workspacePanelCommand (view.panel.workspace)", () => {
  it("opens the tab and shows a hidden panel for a workspace thread", () => {
    usePanelStore.setState({ byKey: {} });
    expect(workspacePanelCommand()).toBe(true);
    expect(getPanel("session:s-ws")).toMatchObject({ open: true, activeTabId: "workspace?workspace=w1" });
    expect(getPanel("session:s-ws").tabs[0]?.title).toBe("demo");
  });

  it("does nothing for a project thread or under the settings page", () => {
    usePanelStore.setState({ byKey: {} });
    select("s-proj");
    expect(workspacePanelCommand()).toBe(false);
    expect(getPanel("session:s-proj").open).toBe(false);
    select("s-ws");
    useViewsStore.setState({ settingsOpen: true });
    expect(workspacePanelCommand()).toBe(false);
    expect(getPanel("session:s-ws").open).toBe(false);
  });

  it("from the palette, sends the palette's focus back to the panel", () => {
    useUiStore.setState((s) => ({ palette: { ...s.palette, open: true, returnTo: "terminal" } }));
    expect(workspacePanelCommand()).toBe(true);
    expect(useUiStore.getState().palette.returnTo).toBe("panel");
  });
});
