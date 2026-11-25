import { create } from "@bufbuild/protobuf";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CheckRollupSchema, CheckRollupState, GhEvent_PullRequestChangedSchema, GhEventSchema, PullRequestSchema, PullRequestState } from "@/gen/codefoundry/v1/gh_pb";
import { toGhEventView, type DashboardView, type PullRequestDetailView, type PullRequestView } from "@/api/gh";
import {
  applyGhEvent,
  branchKey,
  branchPullRequestsResource,
  DASHBOARD_KEY,
  dashboardResource,
  invalidateWatchedGhOnReconnect,
  pollFreshness,
  pullRequestDetailResource,
  pullRequestKey,
  usePollStore,
} from "./gh";

function makePr(o: Partial<PullRequestView> = {}): PullRequestView {
  return {
    repoSlug: "acme/app",
    number: 42,
    title: "Old title",
    author: "alex",
    url: "https://github.com/acme/app/pull/42",
    state: "open",
    draft: false,
    headRef: "feat/x",
    headSha: "111",
    baseRef: "main",
    baseSha: "000",
    review: null,
    checks: { state: "pending", total: 1, passed: 0, failed: 0, pending: 1, skipped: 0 },
    createdAtMs: 1000,
    updatedAtMs: 1000,
    mergedAtMs: null,
    mergeable: "mergeable",
    mergeState: "clean",
    additions: 1,
    deletions: 0,
    changedFiles: 1,
    comments: 0,
    reviews: 0,
    latestReviews: [],
    reviewRequests: [],
    isCrossRepository: false,
    headRepoSlug: "acme/app",
    partial: false,
    ...o,
  };
}

function makeDashboard(o: Partial<DashboardView> = {}): DashboardView {
  return {
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
    trackedSlugs: ["acme/app"],
    projectOpen: { pullRequests: [], totalCount: 0, searchUrl: "" },
    projectMerged: { pullRequests: [], totalCount: 0, searchUrl: "" },
    projectsFetchedAtMs: 1000,
    projectsLastError: "",
    ...o,
  };
}

describe("gh poll freshness", () => {
  afterEach(() => {
    usePollStore.setState({ fetchedAtMs: null, lastError: "", known: false, projectsFetchedAtMs: null, projectsLastError: "" });
  });

  it("uses the data's own time until a polled event arrives", () => {
    expect(pollFreshness(usePollStore.getState(), 1000, "x")).toEqual({ fetchedAtMs: 1000, lastError: "x" });
  });

  it("a later poll confirms unchanged data; its error wins", () => {
    applyGhEvent({ kind: "polled", fetchedAtMs: 5000, lastError: "", projectsFetchedAtMs: null, projectsLastError: "" });
    expect(pollFreshness(usePollStore.getState(), 1000, "")).toEqual({ fetchedAtMs: 5000, lastError: "" });
    applyGhEvent({ kind: "polled", fetchedAtMs: 5000, lastError: "rate limited", projectsFetchedAtMs: null, projectsLastError: "" });
    expect(pollFreshness(usePollStore.getState(), 1000, "")).toEqual({ fetchedAtMs: 5000, lastError: "rate limited" });
    // A failed poll keeps the last success's time.
    applyGhEvent({ kind: "polled", fetchedAtMs: 2000, lastError: "rate limited", projectsFetchedAtMs: null, projectsLastError: "" });
    expect(pollFreshness(usePollStore.getState(), 5000, "").fetchedAtMs).toBe(2000);
  });

  it("the polled event carries the project lists' fetch time and error too", () => {
    applyGhEvent({ kind: "polled", fetchedAtMs: 5000, lastError: "", projectsFetchedAtMs: 4000, projectsLastError: "search timed out" });
    expect(usePollStore.getState()).toMatchObject({ fetchedAtMs: 5000, projectsFetchedAtMs: 4000, projectsLastError: "search timed out" });
  });

  it("a daemon that never polled successfully keeps the data's time", () => {
    applyGhEvent({ kind: "polled", fetchedAtMs: null, lastError: "offline", projectsFetchedAtMs: null, projectsLastError: "" });
    expect(pollFreshness(usePollStore.getState(), 1000, "")).toEqual({ fetchedAtMs: 1000, lastError: "offline" });
  });
});

describe("pull_request_changed in-place cache patching", () => {
  afterEach(() => {
    dashboardResource.store.setState({ entries: {} });
    branchPullRequestsResource.store.setState({ entries: {} });
    pullRequestDetailResource.store.setState({ entries: {} });
  });

  it("maps proto pullRequestChanged and patches dashboard, branch, and detail caches in place", () => {
    const oldPr = makePr();
    const otherPr = makePr({ number: 99, title: "Untouched" });
    dashboardResource.set(DASHBOARD_KEY, {
      data: makeDashboard({
        authored: [oldPr, otherPr],
        reviewRequested: [oldPr],
        reviewed: [oldPr],
        recentlyMerged: [oldPr],
        projectOpen: { pullRequests: [oldPr], totalCount: 1, searchUrl: "" },
        projectMerged: { pullRequests: [oldPr], totalCount: 1, searchUrl: "" },
      }),
    });
    const bKey = branchKey("acme/app", "feat/x");
    branchPullRequestsResource.set(bKey, { data: { pullRequests: [oldPr], fetchedAtMs: 1000, lastError: "" } });
    const dKey = pullRequestKey("acme/app", 42);
    pullRequestDetailResource.set(dKey, {
      data: { pullRequest: oldPr, body: "keep body", comments: [{ id: "c1" }], commits: [{ sha: "111" }] } as unknown as PullRequestDetailView,
    });

    const mapped = toGhEventView(
      create(GhEventSchema, {
        event: {
          case: "pullRequestChanged",
          value: create(GhEvent_PullRequestChangedSchema, {
            repoSlug: "acme/app",
            number: 42,
            headRef: "feat/x",
            pullRequest: create(PullRequestSchema, {
              repoSlug: "acme/app",
              number: 42,
              title: "New title",
              state: PullRequestState.MERGED,
              headRef: "feat/x",
              headSha: "222",
              checks: create(CheckRollupSchema, { state: CheckRollupState.SUCCESS, total: 2, passed: 2 }),
            }),
          }),
        },
      }),
    );
    expect(mapped?.kind).toBe("pullRequestChanged");
    if (mapped) applyGhEvent(mapped);

    const dash = dashboardResource.store.getState().entries[DASHBOARD_KEY]?.data;
    expect(dash?.authored[0]?.title).toBe("New title");
    expect(dash?.authored[0]?.state).toBe("merged");
    expect(dash?.authored[1]).toBe(otherPr);
    expect(dash?.reviewRequested[0]?.title).toBe("New title");
    expect(dash?.reviewed[0]?.title).toBe("New title");
    expect(dash?.recentlyMerged[0]?.title).toBe("New title");
    expect(dash?.projectOpen.pullRequests[0]?.title).toBe("New title");
    expect(dash?.projectMerged.pullRequests[0]?.title).toBe("New title");

    const branch = branchPullRequestsResource.store.getState().entries[bKey]?.data;
    expect(branch?.pullRequests[0]?.title).toBe("New title");
    expect(branch?.pullRequests[0]?.checks.state).toBe("success");

    const detail = pullRequestDetailResource.store.getState().entries[dKey]?.data;
    expect(detail?.pullRequest.title).toBe("New title");
    expect(detail?.pullRequest.headSha).toBe("222");
    expect(detail?.body).toBe("keep body");
    expect(detail?.comments).toHaveLength(1);
    expect(detail?.commits).toHaveLength(1);
  });

  it("ignores partial pullRequest payloads and leaves unrelated entries untouched", () => {
    const oldPr = makePr();
    dashboardResource.set(DASHBOARD_KEY, { data: makeDashboard({ authored: [oldPr] }) });
    const beforeDash = dashboardResource.store.getState().entries;

    applyGhEvent({ kind: "pullRequestChanged", repoSlug: "acme/app", number: 42, headRef: "feat/x", pullRequest: makePr({ title: "", partial: true }) });
    expect(dashboardResource.store.getState().entries).toBe(beforeDash);

    applyGhEvent({ kind: "pullRequestChanged", repoSlug: "acme/app", number: 777, headRef: "other", pullRequest: makePr({ number: 777, title: "Other" }) });
    expect(dashboardResource.store.getState().entries).toBe(beforeDash);

    expect(toGhEventView(create(GhEventSchema, { event: { case: "pullRequestChanged", value: create(GhEvent_PullRequestChangedSchema, { repoSlug: "acme/app", number: 1 }) } }))).toBeNull();
  });

  it("invalidateWatchedGhOnReconnect invalidates watched branch and detail resources", () => {
    const bInv = vi.spyOn(branchPullRequestsResource, "invalidate");
    const dInv = vi.spyOn(pullRequestDetailResource, "invalidate");
    invalidateWatchedGhOnReconnect();
    expect(bInv).toHaveBeenCalledTimes(1);
    expect(dInv).toHaveBeenCalledTimes(1);
    bInv.mockRestore();
    dInv.mockRestore();
  });
});
