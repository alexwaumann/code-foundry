import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";
import {
  CheckConclusion,
  CheckRollupState,
  GhService,
  Mergeable,
  MergeStateStatus,
  PullRequestReviewState,
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

// View models for GhService's reads. Generated types stay in src/api.

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

export type MergeableView = "mergeable" | "conflicting" | "unknown" | null;

export interface ReviewEntryView {
  author: string;
  /** Lower case GitHub review state ("approved", "changes_requested", ...); "" if unknown. */
  state: string;
  submittedAtMs: number | null;
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
  // Detail the poll keeps for every PR in the viewer's scope (open PRs only for the
  // review and merge fields). Not shown yet; available to views.
  mergeable: MergeableView;
  /** Lower case GitHub merge state ("clean", "blocked", "behind", ...); "" if unknown. */
  mergeState: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  comments: number;
  reviews: number;
  latestReviews: ReviewEntryView[];
  /** Pending review requests: logins and "org/team". */
  reviewRequests: string[];
  isCrossRepository: boolean;
  /** Only the poll's fingerprint is known yet (title and details empty). */
  partial: boolean;
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
  /** Open PRs the viewer reviewed and did not author (not shown yet). */
  reviewed: PullRequestView[];
  recentlyMerged: PullRequestView[];
  /** github.dashboards_enabled is off: the lists are empty and not polled. */
  dashboardsDisabled: boolean;
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
  lastError: string;
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

/**
 * GhService notification: re-read the cached data, except "polled", which carries the
 * last poll's time and error itself (sent after every poll; the others only on change).
 */
export type GhEventView =
  | { kind: "polled"; fetchedAtMs: number | null; lastError: string }
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

const mergeables: Record<Mergeable, MergeableView> = {
  [Mergeable.UNSPECIFIED]: null,
  [Mergeable.MERGEABLE]: "mergeable",
  [Mergeable.CONFLICTING]: "conflicting",
  [Mergeable.UNKNOWN]: "unknown",
};

/** Lower-cased enum name without its prefix; "" for UNSPECIFIED. */
function enumName(names: Record<number, string>, v: number): string {
  return v === 0 ? "" : (names[v] ?? "").toLowerCase();
}

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
    mergeable: mergeables[p.mergeable],
    mergeState: enumName(MergeStateStatus, p.mergeStateStatus),
    additions: p.additions,
    deletions: p.deletions,
    changedFiles: p.changedFiles,
    comments: p.commentCount,
    reviews: p.reviewCount,
    latestReviews: p.latestReviews.map((r) => ({ author: r.author, state: enumName(PullRequestReviewState, r.state), submittedAtMs: ms(r.submittedAt) })),
    reviewRequests: p.reviewRequests,
    isCrossRepository: p.isCrossRepository,
    partial: p.partial,
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
    case "polled":
      return { kind: "polled", fetchedAtMs: ms(g.value.fetchedAt), lastError: g.value.lastError };
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
    reviewed: r.reviewed.map(toPullRequestView),
    recentlyMerged: r.recentlyMerged.map(toPullRequestView),
    dashboardsDisabled: r.dashboardsDisabled,
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
          lastError: d.lastError,
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
