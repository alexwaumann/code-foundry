import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchPullRequestsView, PullRequestView } from "@/api/gh";
import type { RepoView, WorktreeView } from "@/api/repo";
import type { SessionView } from "@/api/session";

const getBranchPullRequests = vi.hoisted(() => vi.fn());
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), getBranchPullRequests }));

const { SidePanel } = await import("@/components/panel/SidePanel");
const { usePanelStore } = await import("@/stores/panel");
const { useReposStore } = await import("@/stores/repos");
const { useSessionsStore } = await import("@/stores/sessions");
const { useUiStore } = await import("@/stores/ui");
const { useViewsStore } = await import("@/stores/views");
const { pullRequestSurface } = await import("./pullrequest");

const status = { upstream: "", ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, dirty: false, refreshedAtMs: null };
const wt = (path: string, branch: string, isMain = false): WorktreeView => ({ repoId: "r1", path, branch, head: "abc", detached: false, isMain, status });
const repo = (branch: string): RepoView => ({ id: "r1", path: "/src/cf", name: "cf", defaultBranch: "main", githubSlug: "Alex/CF", remotes: ["origin"], git: true, worktrees: [wt("/src/cf", "main", true), wt("/src/cf-work", branch)] });
const session = { id: "s1", worktreePath: "/src/cf-work", repoId: "r1", terminalId: "" } as SessionView;
const prs = (n: number[]): BranchPullRequestsView => ({ pullRequests: n.map((number) => ({ repoSlug: "alex/cf", number, state: "open" }) as PullRequestView), fetchedAtMs: 1, lastError: "" });

beforeEach(() => {
  getBranchPullRequests.mockImplementation((_slug: string, head: string) => Promise.resolve(prs(head === "fix/resize" ? [145] : [])));
  useReposStore.setState({ byId: { r1: repo("feat/nopr") }, order: ["r1"] });
  useSessionsStore.setState({ byId: { s1: session }, order: ["s1"] });
  usePanelStore.setState({ byKey: { "session:s1": { open: true, tabs: [], activeTabId: null } } });
  useViewsStore.setState({ settingsOpen: false });
  useUiStore.setState({ selection: { kind: "session", id: "s1" }, windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260 });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Pull request surface availability", () => {
  it("follows the session's worktree when it switches to a branch with a pull request, and back", async () => {
    render(<SidePanel />);
    const row = () => screen.getByTestId("panel-empty").querySelector('[data-surface="pullrequest"]');
    await vi.waitFor(() => {
      expect(getBranchPullRequests).toHaveBeenCalledWith("alex/cf", "feat/nopr", undefined, expect.anything());
    });
    expect(row()?.getAttribute("data-availability")).toBe("disabled");

    // `git switch fix/resize` in the worktree: the repos store reports the new branch.
    act(() => {
      useReposStore.setState({ byId: { r1: repo("fix/resize") } });
    });
    await vi.waitFor(() => {
      expect(row()?.getAttribute("data-availability")).toBe("enabled");
    });
    expect(getBranchPullRequests).toHaveBeenLastCalledWith("alex/cf", "fix/resize", undefined, expect.anything());
    expect(pullRequestSurface.openDefault({ selection: { kind: "session", id: "s1" }, panelKey: "session:s1" })?.title).toBe("#145");

    act(() => {
      useReposStore.setState({ byId: { r1: repo("feat/nopr") } });
    });
    await vi.waitFor(() => {
      expect(row()?.getAttribute("data-availability")).toBe("disabled");
    });
  });
});
