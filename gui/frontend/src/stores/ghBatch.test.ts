import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchPullRequestsBatchEntry, BranchPullRequestsQuery, BranchPullRequestsView, DashboardView } from "@/api/gh";

const calls = vi.hoisted(() => ({
  single: [] as { slug: string; head: string; signal?: AbortSignal }[],
  batch: [] as { branches: readonly BranchPullRequestsQuery[]; signal?: AbortSignal }[],
  dashboard: [] as boolean[],
  singleImpl: null as ((slug: string, head: string, signal?: AbortSignal) => Promise<BranchPullRequestsView>) | null,
  batchImpl: null as ((branches: readonly BranchPullRequestsQuery[], signal?: AbortSignal) => Promise<BranchPullRequestsBatchEntry[]>) | null,
}));

vi.mock("@/api/gh", async (orig) => ({
  ...(await orig<typeof import("@/api/gh")>()),
  getDashboard: (_conn?: unknown, _signal?: AbortSignal, opts?: { watchProjects?: boolean }): Promise<DashboardView> => {
    calls.dashboard.push(opts?.watchProjects === true);
    return Promise.resolve({
      viewer: null,
      authenticated: true,
      authored: [],
      reviewRequested: [],
      reviewed: [],
      recentlyMerged: [],
      dashboardsDisabled: false,
      stats: { months: [], commitsSource: "", fetchedAtMs: null, lastError: "" },
      fetchedAtMs: 1000,
      lastError: "",
      trackedSlugs: [],
      projectOpen: { pullRequests: [], totalCount: 0, searchUrl: "" },
      projectMerged: { pullRequests: [], totalCount: 0, searchUrl: "" },
      projectsFetchedAtMs: 1000,
      projectsLastError: "",
    });
  },
  getBranchPullRequests: (repoSlug: string, headRef: string, _conn?: unknown, signal?: AbortSignal): Promise<BranchPullRequestsView> => {
    calls.single.push({ slug: repoSlug, head: headRef, signal });
    if (calls.singleImpl) return calls.singleImpl(repoSlug, headRef, signal);
    return Promise.resolve({ pullRequests: [], fetchedAtMs: 1000, lastError: `${repoSlug}@${headRef}` });
  },
  getBranchesPullRequests: (branches: readonly BranchPullRequestsQuery[], _conn?: unknown, signal?: AbortSignal): Promise<BranchPullRequestsView[]> => {
    calls.batch.push({ branches, signal });
    if (calls.batchImpl) return calls.batchImpl(branches, signal);
    return Promise.resolve(branches.map((b) => ({ pullRequests: [], fetchedAtMs: 2000, lastError: `${b.repoSlug}@${b.headRef}` })));
  },
}));

const { applyGhEvent, branchKey, DASHBOARD_KEY, dashboardResource, loadBranchPullRequests, PROJECTS_WATCH_KEEPALIVE_MS, watchProjects } = await import("./gh");

function setVisibility(state: DocumentVisibilityState): void {
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => state });
  Object.defineProperty(document, "hidden", { configurable: true, get: () => state === "hidden" });
  document.dispatchEvent(new Event("visibilitychange"));
}

beforeEach(() => {
  calls.single.length = 0;
  calls.batch.length = 0;
  calls.dashboard.length = 0;
  calls.singleImpl = null;
  calls.batchImpl = null;
});

afterEach(() => {
  setVisibility("visible");
  vi.useRealTimers();
});

describe("branch pull requests microtask batcher", () => {
  it("uses single getBranchPullRequests when only one branch is requested in a tick", async () => {
    const ctl = new AbortController();
    const res = await loadBranchPullRequests(branchKey("acme/app", "feat/one"), ctl.signal);
    expect(res.lastError).toBe("acme/app@feat/one");
    expect(calls.single).toHaveLength(1);
    expect(calls.batch).toHaveLength(0);
  });

  it("coalesces multiple branches in the same microtask into one getBranchesPullRequests RPC and deduplicates duplicate keys", async () => {
    const c1 = new AbortController();
    const c2 = new AbortController();
    const c3 = new AbortController();
    const [r1, r2, r3] = await Promise.all([
      loadBranchPullRequests(branchKey("acme/a", "feat-1"), c1.signal),
      loadBranchPullRequests(branchKey("acme/b", "feat-2"), c2.signal),
      loadBranchPullRequests(branchKey("acme/a", "feat-1"), c3.signal),
    ]);
    expect(calls.single).toHaveLength(0);
    expect(calls.batch).toHaveLength(1);
    expect(calls.batch[0]?.branches).toEqual([
      { repoSlug: "acme/a", headRef: "feat-1" },
      { repoSlug: "acme/b", headRef: "feat-2" },
    ]);
    expect(r1.lastError).toBe("acme/a@feat-1");
    expect(r2.lastError).toBe("acme/b@feat-2");
    expect(r3.lastError).toBe("acme/a@feat-1");
  });

  it("cancels only the aborted key without aborting sibling keys in the same batch", async () => {
    let resolveBatch!: (v: BranchPullRequestsView[]) => void;
    let seenSignal: AbortSignal | undefined;
    calls.batchImpl = (_branches, signal) => {
      seenSignal = signal;
      return new Promise<BranchPullRequestsView[]>((r) => {
        resolveBatch = r;
      });
    };

    const c1 = new AbortController();
    const c2 = new AbortController();
    const c3 = new AbortController();
    // Abort c1 before the microtask flushes: dropped before the RPC is even sent.
    const p1 = loadBranchPullRequests(branchKey("acme/a", "pre-aborted"), c1.signal);
    const p2 = loadBranchPullRequests(branchKey("acme/a", "mid-aborted"), c2.signal);
    const p3 = loadBranchPullRequests(branchKey("acme/b", "kept"), c3.signal);
    c1.abort();
    await expect(p1).rejects.toThrow(/aborted/i);

    // Let microtask flush: only p2 and p3 are sent.
    await Promise.resolve();
    expect(calls.batch).toHaveLength(1);
    expect(calls.batch[0]?.branches).toEqual([
      { repoSlug: "acme/a", headRef: "mid-aborted" },
      { repoSlug: "acme/b", headRef: "kept" },
    ]);
    expect(seenSignal?.aborted).toBe(false);

    // Abort p2 while the batch RPC is in flight: p2 rejects, but the shared RPC signal stays live for p3.
    c2.abort();
    await expect(p2).rejects.toThrow(/aborted/i);
    expect(seenSignal?.aborted).toBe(false);

    resolveBatch([
      { pullRequests: [], fetchedAtMs: 1, lastError: "mid" },
      { pullRequests: [], fetchedAtMs: 2, lastError: "kept-ok" },
    ]);
    await expect(p3).resolves.toMatchObject({ fetchedAtMs: 2, lastError: "kept-ok" });
  });

  it("aborts the underlying batch RPC signal only when every key in the batch is aborted", async () => {
    let seenSignal: AbortSignal | undefined;
    calls.batchImpl = (_branches, signal) => {
      seenSignal = signal;
      return new Promise<BranchPullRequestsView[]>((_r, reject) => {
        signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    };

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = loadBranchPullRequests(branchKey("acme/a", "b1"), c1.signal);
    const p2 = loadBranchPullRequests(branchKey("acme/a", "b2"), c2.signal);
    await Promise.resolve();
    expect(seenSignal?.aborted).toBe(false);

    c1.abort();
    await expect(p1).rejects.toThrow(/aborted/i);
    expect(seenSignal?.aborted).toBe(false);

    c2.abort();
    await expect(p2).rejects.toThrow(/aborted/i);
    expect(seenSignal?.aborted).toBe(true);
  });

  it("matches keyed batch responses by (repoSlug, headRef) so a short response never shifts siblings", async () => {
    calls.batchImpl = () =>
      Promise.resolve([{ repoSlug: "acme/b", headRef: "b2", pullRequests: [], fetchedAtMs: 2000, lastError: "ok-b2" }]);

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = loadBranchPullRequests(branchKey("acme/a", "b1"), c1.signal);
    const p2 = loadBranchPullRequests(branchKey("acme/b", "b2"), c2.signal);
    await expect(p1).rejects.toThrow(/missing branch pull requests entry/i);
    await expect(p2).resolves.toMatchObject({ lastError: "ok-b2" });
  });

  it("falls back to single reads when a batch fails with InvalidArgument so one bad key does not fail siblings", async () => {
    calls.batchImpl = () => Promise.reject(new ConnectError("bad slug", Code.InvalidArgument));
    calls.singleImpl = (slug, head) =>
      slug === "bad"
        ? Promise.reject(new ConnectError("invalid repo", Code.InvalidArgument))
        : Promise.resolve({ pullRequests: [], fetchedAtMs: 3000, lastError: `${slug}@${head}` });

    const c1 = new AbortController();
    const c2 = new AbortController();
    const p1 = loadBranchPullRequests(branchKey("bad", "feat"), c1.signal);
    const p2 = loadBranchPullRequests(branchKey("acme/good", "feat"), c2.signal);
    await expect(p1).rejects.toThrow(/invalid repo/i);
    await expect(p2).resolves.toMatchObject({ lastError: "acme/good@feat" });
    expect(calls.batch).toHaveLength(1);
    expect(calls.single).toHaveLength(2);
  });
});

describe("watchProjects keepalive lease", () => {
  // Every watch a test takes is let go after it, even when an assertion failed first, so
  // one failing test cannot leave a watcher (and its timer) to the next.
  const held: (() => void)[] = [];
  const hold = (release: () => void): (() => void) => {
    let done = false;
    const once = () => {
      if (done) return;
      done = true;
      release();
    };
    held.push(once);
    return once;
  };
  afterEach(() => {
    for (const release of held.splice(0)) release();
  });

  it("renews watchProjects every 5 minutes while held and stops once released", async () => {
    vi.useFakeTimers();
    const releaseDash = hold(dashboardResource.watch(DASHBOARD_KEY));
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.dashboard).toEqual([false]);

    const releaseProjects = hold(watchProjects());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.dashboard).toEqual([false, true]);

    await vi.advanceTimersByTimeAsync(PROJECTS_WATCH_KEEPALIVE_MS);
    expect(calls.dashboard).toEqual([false, true, true]);

    releaseProjects();
    await vi.advanceTimersByTimeAsync(PROJECTS_WATCH_KEEPALIVE_MS * 2);
    expect(calls.dashboard).toEqual([false, true, true]);

    dashboardResource.invalidate(DASHBOARD_KEY);
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.dashboard).toEqual([false, true, true, false]);
    releaseDash();
  });

  it("sends no renewal while the window is hidden, and renews once on return", async () => {
    vi.useFakeTimers();
    const releaseDash = hold(dashboardResource.watch(DASHBOARD_KEY));
    const releaseProjects = hold(watchProjects());
    await vi.advanceTimersByTimeAsync(0);
    calls.dashboard.length = 0;

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(PROJECTS_WATCH_KEEPALIVE_MS * 3);
    expect(calls.dashboard).toEqual([]);

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.dashboard).toEqual([true]);

    // The keepalive resumes a full period after the return's renewal, not sooner.
    await vi.advanceTimersByTimeAsync(PROJECTS_WATCH_KEEPALIVE_MS - 1);
    expect(calls.dashboard).toEqual([true]);
    await vi.advanceTimersByTimeAsync(1);
    expect(calls.dashboard).toEqual([true, true]);
    releaseProjects();
    releaseDash();
  });

  it("does not renew the lease from a dashboard read made while hidden", async () => {
    vi.useFakeTimers();
    const releaseDash = hold(dashboardResource.watch(DASHBOARD_KEY));
    const releaseProjects = hold(watchProjects());
    await vi.advanceTimersByTimeAsync(0);
    calls.dashboard.length = 0;

    // The daemon's own poll changes the dashboard while nobody looks: the re-read is a
    // plain read, or PollProjects publishing changes would keep its own lease alive.
    setVisibility("hidden");
    applyGhEvent({ kind: "dashboard" });
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.dashboard).toEqual([false]);
    releaseProjects();
    releaseDash();
  });

  it("sends nothing extra for a hide shorter than the keepalive", async () => {
    vi.useFakeTimers();
    const releaseDash = hold(dashboardResource.watch(DASHBOARD_KEY));
    const releaseProjects = hold(watchProjects());
    await vi.advanceTimersByTimeAsync(0);
    calls.dashboard.length = 0;

    await vi.advanceTimersByTimeAsync(60_000);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(60_000);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.dashboard).toEqual([]);

    // The keepalive kept its schedule: due 5 minutes after the watch began.
    await vi.advanceTimersByTimeAsync(PROJECTS_WATCH_KEEPALIVE_MS - 120_000);
    expect(calls.dashboard).toEqual([true]);
    releaseProjects();
    releaseDash();
  });

  it("renews once for many quick flips after a missed keepalive", async () => {
    vi.useFakeTimers();
    const releaseDash = hold(dashboardResource.watch(DASHBOARD_KEY));
    const releaseProjects = hold(watchProjects());
    await vi.advanceTimersByTimeAsync(0);
    calls.dashboard.length = 0;

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(PROJECTS_WATCH_KEEPALIVE_MS);
    for (let i = 0; i < 10; i++) {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(50);
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(50);
    }
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.dashboard).toEqual([true]);
    releaseProjects();
    releaseDash();
  });

  it("renews on return when the watch began while hidden", async () => {
    vi.useFakeTimers();
    const releaseDash = hold(dashboardResource.watch(DASHBOARD_KEY));
    await vi.advanceTimersByTimeAsync(0);
    calls.dashboard.length = 0;

    // Nothing to renew while hidden: the first read waits for the window to show.
    setVisibility("hidden");
    const releaseProjects = hold(watchProjects());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.dashboard).toEqual([]);

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.dashboard).toEqual([true]);
    releaseProjects();
    releaseDash();
  });

  it("clears everything when released while hidden", async () => {
    vi.useFakeTimers();
    const releaseDash = hold(dashboardResource.watch(DASHBOARD_KEY));
    const releaseProjects = hold(watchProjects());
    await vi.advanceTimersByTimeAsync(0);
    calls.dashboard.length = 0;

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(PROJECTS_WATCH_KEEPALIVE_MS);
    releaseProjects();
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(PROJECTS_WATCH_KEEPALIVE_MS * 2);
    expect(calls.dashboard).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);

    // A later watch starts clean: one read, then the keepalive.
    const again = hold(watchProjects());
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.dashboard).toEqual([true]);
    again();
    releaseDash();
  });

  it("holds one keepalive for two watchers until the last lets go", async () => {
    vi.useFakeTimers();
    const releaseDash = hold(dashboardResource.watch(DASHBOARD_KEY));
    const page = hold(watchProjects());
    const bridge = hold(watchProjects());
    await vi.advanceTimersByTimeAsync(0);
    calls.dashboard.length = 0;

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(PROJECTS_WATCH_KEEPALIVE_MS);
    page();
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.dashboard).toEqual([true]);

    await vi.advanceTimersByTimeAsync(PROJECTS_WATCH_KEEPALIVE_MS);
    expect(calls.dashboard).toEqual([true, true]);

    bridge();
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(PROJECTS_WATCH_KEEPALIVE_MS);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(PROJECTS_WATCH_KEEPALIVE_MS);
    expect(calls.dashboard).toEqual([true, true]);
    releaseDash();
  });
});
