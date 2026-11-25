import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchPullRequestsQuery, BranchPullRequestsView } from "@/api/gh";
import type { ProjectView } from "@/api/project";

const rpcCounts = vi.hoisted(() => ({ single: 0, batch: 0, batchSizes: [] as number[] }));

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => {
  const real = await orig<typeof import("@/api/gh")>();
  const fakes = (await import("@/test/daemonFakes")).ghFakes;
  return {
    ...real,
    ...fakes,
    getBranchPullRequests: (repoSlug: string, headRef: string): Promise<BranchPullRequestsView> => {
      rpcCounts.single++;
      return fakes.getBranchPullRequests(repoSlug, headRef);
    },
    getBranchesPullRequests: (branches: readonly BranchPullRequestsQuery[]): Promise<BranchPullRequestsView[]> => {
      rpcCounts.batch++;
      rpcCounts.batchSizes.push(branches.length);
      return fakes.getBranchesPullRequests(branches);
    },
  };
});
vi.mock("@/api/worktreeDetail", async (orig) => ({ ...(await orig<typeof import("@/api/worktreeDetail")>()), ...(await import("@/test/daemonFakes")).detailFakes }));

const { ProjectsPage } = await import("./ProjectsPage");
const { daemon, resetDaemon } = await import("@/test/daemonFakes");
const { pullRequest, seedWorld, worktree } = await import("@/test/projectsWorld");
const { useProjectsStore } = await import("@/stores/projects");
const { branchPullRequestsResource, invalidateWatchedGhOnReconnect } = await import("@/stores/gh");

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

beforeEach(() => {
  resetDaemon();
  seedWorld();
  rpcCounts.single = 0;
  rpcCounts.batch = 0;
  rpcCounts.batchSizes.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("ProjectsIndex branch PR RPC batching", () => {
  it("batches 16 worktree branches across 4 projects into 1 unary RPC on mount and on reconnect invalidation", async () => {
    const projects: ProjectView[] = Array.from({ length: 4 }, (_, p) => {
      const id = `repo-${String(p)}`;
      const slug = `acme/repo-${String(p)}`;
      const root = `/Users/dev/src/repo-${String(p)}`;
      const branches = Array.from({ length: 4 }, (_, b) => `feat/branch-${String(p)}-${String(b)}`);
      // Give the first branch of each project an open PR so we verify results populate every row.
      daemon.branchPullRequests.set(`${slug}\u0000${branches[0] ?? ""}`, {
        pullRequests: [pullRequest({ repoSlug: slug, number: 100 + p, title: `PR ${String(p)}`, state: "open", headRef: branches[0] ?? "" })],
        fetchedAtMs: Date.now(),
        lastError: "",
      });
      return {
        id,
        path: root,
        name: `repo-${String(p)}`,
        defaultBranch: "main",
        githubSlug: slug,
        remotes: ["origin"],
        git: true,
        worktrees: [
          worktree(id, root, "main", { isMain: true }),
          ...branches.map((branch, b) => worktree(id, `${root}.worktrees/feat-${String(b)}`, branch)),
        ],
      };
    });
    branchPullRequestsResource.store.setState({ entries: {} });
    useProjectsStore.setState({
      byId: Object.fromEntries(projects.map((p) => [p.id, p])),
      order: projects.map((p) => p.id),
      loaded: true,
    });

    render(<ProjectsPage />);
    await settle();

    expect(rpcCounts.single).toBe(0);
    expect(rpcCounts.batch).toBe(1);
    expect(rpcCounts.batchSizes).toEqual([16]);
    expect(screen.getAllByTestId("index-prs")).toHaveLength(4);

    // Reconnect invalidation of all 16 watched branches also coalesces into 1 batched RPC.
    rpcCounts.single = 0;
    rpcCounts.batch = 0;
    rpcCounts.batchSizes.length = 0;
    act(() => {
      invalidateWatchedGhOnReconnect();
    });
    await settle();
    expect(rpcCounts.single).toBe(0);
    expect(rpcCounts.batch).toBe(1);
    expect(rpcCounts.batchSizes).toEqual([16]);
  });
});
