import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";
import {
  CheckConclusion,
  CheckRollupState,
  GhService,
  PullRequestState,
  ReviewDecision,
  type ActivityStats,
  type CheckRollup,
  type CheckRun,
  type GhEvent,
  type MonthActivity,
  type PullRequest,
} from "@/gen/codefoundry/v1/gh_pb";
import { daemon, type DaemonConnection } from "./endpoint";

// View models for GhService's Phase 3a RPCs. Generated types stay in src/api.

export type RollupStateView = "none" | "pending" | "success" | "failure" | "error" | "expected";
export type ReviewView = "approved" | "changes_requested" | "review_required" | null;
export type PrStateView = "open" | "closed" | "merged" | "unknown";

export interface CheckRollupView {
  state: RollupStateView;
  total: number;
  passed: number;
  failed: number;
  pending: number;
  skipped: number;
}

export interface CheckRunView {
  name: string;
  workflow: string;
  url: string;
  conclusion: string; // lower case GitHub conclusion, "" while running
}

export interface PullRequestView {
  repoSlug: string;
  number: number;
  title: string;
  author: string;
  url: string;
  state: PrStateView;
  draft: boolean;
  headRef: string;
  baseRef: string;
  review: ReviewView;
  checks: CheckRollupView;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  mergedAtMs: number | null;
}

export interface MonthView {
  /** "YYYY-MM"; "" when never fetched. */
  month: string;
  commits: number;
  merged: number;
}

export interface StatsView {
  thisMonth: MonthView;
  lastMonth: MonthView;
  commitsSource: string;
  fetchedAtMs: number | null;
  lastError: string;
}

export interface ViewerView {
  login: string;
  name: string;
  url: string;
}

export interface DashboardView {
  viewer: ViewerView | null;
  authenticated: boolean;
  authored: PullRequestView[];
  reviewRequested: PullRequestView[];
  recentlyMerged: PullRequestView[];
  stats: StatsView;
  fetchedAtMs: number | null;
  lastError: string;
  trackedSlugs: string[];
}

export interface DefaultBranchView {
  branch: string;
  sha: string;
  headline: string;
  committedAtMs: number | null;
  rollup: CheckRollupView;
  failing: CheckRunView[];
  fetchedAtMs: number | null;
}

export interface RepoActivityView {
  repoSlug: string;
  tracked: boolean;
  stats: StatsView;
  defaultBranch: DefaultBranchView | null;
  recentlyMerged: PullRequestView[];
}

export interface BranchPullRequestsView {
  pullRequests: PullRequestView[];
  fetchedAtMs: number | null;
  lastError: string;
}

/** GhService change notification (re-read the cached data). */
export type GhEventView =
  | { kind: "pullRequests"; repoSlug: string }
  | { kind: "viewer" }
  | { kind: "dashboard" }
  | { kind: "repoActivity"; repoSlug: string }
  | { kind: "branchPullRequests"; repoSlug: string; headRef: string };

const ms = (t: Timestamp | undefined): number | null => (t ? timestampMs(t) : null);

const rollupStates: Record<CheckRollupState, RollupStateView> = {
  [CheckRollupState.UNSPECIFIED]: "none",
  [CheckRollupState.PENDING]: "pending",
  [CheckRollupState.SUCCESS]: "success",
  [CheckRollupState.FAILURE]: "failure",
  [CheckRollupState.ERROR]: "error",
  [CheckRollupState.EXPECTED]: "expected",
};

const reviews: Record<ReviewDecision, ReviewView> = {
  [ReviewDecision.UNSPECIFIED]: null,
  [ReviewDecision.APPROVED]: "approved",
  [ReviewDecision.CHANGES_REQUESTED]: "changes_requested",
  [ReviewDecision.REVIEW_REQUIRED]: "review_required",
};

const prStates: Record<PullRequestState, PrStateView> = {
  [PullRequestState.UNSPECIFIED]: "unknown",
  [PullRequestState.OPEN]: "open",
  [PullRequestState.CLOSED]: "closed",
  [PullRequestState.MERGED]: "merged",
};

export function toRollupView(r: CheckRollup | undefined): CheckRollupView {
  return {
    state: r ? rollupStates[r.state] : "none",
    total: r?.total ?? 0,
    passed: r?.passed ?? 0,
    failed: r?.failed ?? 0,
    pending: r?.pending ?? 0,
    skipped: r?.skipped ?? 0,
  };
}

function toCheckRunView(c: CheckRun): CheckRunView {
  const conclusion = c.conclusion === CheckConclusion.UNSPECIFIED ? "" : CheckConclusion[c.conclusion].toLowerCase();
  return { name: c.name, workflow: c.workflow, url: c.url, conclusion };
}

export function toPullRequestView(p: PullRequest): PullRequestView {
  return {
    repoSlug: p.repoSlug,
    number: p.number,
    title: p.title,
    author: p.author,
    url: p.url,
    state: prStates[p.state],
    draft: p.draft,
    headRef: p.headRef,
    baseRef: p.baseRef,
    review: reviews[p.reviewDecision],
    checks: toRollupView(p.checks),
    createdAtMs: ms(p.createdAt),
    updatedAtMs: ms(p.updatedAt),
    mergedAtMs: ms(p.mergedAt),
  };
}

function toMonthView(m: MonthActivity | undefined): MonthView {
  return { month: m?.month ?? "", commits: m?.commits ?? 0, merged: m?.merged ?? 0 };
}

export function toStatsView(s: ActivityStats | undefined): StatsView {
  return {
    thisMonth: toMonthView(s?.thisMonth),
    lastMonth: toMonthView(s?.lastMonth),
    commitsSource: s?.commitsSource ?? "",
    fetchedAtMs: ms(s?.fetchedAt),
    lastError: s?.lastError ?? "",
  };
}

export function toGhEventView(e: GhEvent): GhEventView | null {
  const g = e.event;
  switch (g.case) {
    case "pullRequestsUpdated":
      return { kind: "pullRequests", repoSlug: g.value.repoSlug };
    case "viewerUpdated":
      return { kind: "viewer" };
    case "dashboardUpdated":
      return { kind: "dashboard" };
    case "repoActivityUpdated":
      return { kind: "repoActivity", repoSlug: g.value.repoSlug };
    case "branchPullRequestsUpdated":
      return { kind: "branchPullRequests", repoSlug: g.value.repoSlug, headRef: g.value.headRef };
    default:
      return null;
  }
}

export async function getDashboard(includeUntracked = false, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<DashboardView> {
  const c = await conn.client(GhService);
  const r = await c.getDashboard({ includeUntracked }, { signal });
  return {
    viewer: r.viewer ? { login: r.viewer.login, name: r.viewer.name, url: r.viewer.url } : null,
    authenticated: r.authenticated,
    authored: r.authored.map(toPullRequestView),
    reviewRequested: r.reviewRequested.map(toPullRequestView),
    recentlyMerged: r.recentlyMerged.map(toPullRequestView),
    stats: toStatsView(r.stats),
    fetchedAtMs: ms(r.fetchedAt),
    lastError: r.lastError,
    trackedSlugs: r.trackedSlugs,
  };
}

export async function getRepoActivity(repoSlug: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<RepoActivityView> {
  const c = await conn.client(GhService);
  const r = await c.getRepoActivity({ repoSlug }, { signal });
  const d = r.defaultBranch;
  return {
    repoSlug: r.repoSlug,
    tracked: r.tracked,
    stats: toStatsView(r.stats),
    defaultBranch: d
      ? {
          branch: d.branch,
          sha: d.sha,
          headline: d.headline,
          committedAtMs: ms(d.committedAt),
          rollup: toRollupView(d.rollup),
          failing: d.failing.map(toCheckRunView),
          fetchedAtMs: ms(d.fetchedAt),
        }
      : null,
    recentlyMerged: r.recentlyMerged.map(toPullRequestView),
  };
}

export async function getBranchPullRequests(
  repoSlug: string,
  headRef: string,
  conn: DaemonConnection = daemon,
  signal?: AbortSignal,
): Promise<BranchPullRequestsView> {
  const c = await conn.client(GhService);
  const r = await c.getBranchPullRequests({ repoSlug, headRef }, { signal });
  return { pullRequests: r.pullRequests.map(toPullRequestView), fetchedAtMs: ms(r.fetchedAt), lastError: r.lastError };
}
