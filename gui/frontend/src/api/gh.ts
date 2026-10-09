import { create } from "@bufbuild/protobuf";
import { timestampMs, type Timestamp } from "@bufbuild/protobuf/wkt";
import {
  CheckConclusion,
  CheckRollupState,
  CheckStatus,
  DiffSide,
  GhService,
  Mergeable,
  MergeStateStatus,
  PullRequestCommentKind,
  PullRequestDetailSchema,
  PullRequestReviewState,
  PullRequestSchema,
  PullRequestState,
  ReviewDecision,
  ReviewerKind,
  type ActivityStats,
  type CheckRollup,
  type CheckRun,
  type GhEvent,
  type MonthActivity,
  type PullRequest,
  type PullRequestComment,
  type PullRequestDetail,
  type ReviewerCandidate,
} from "@/gen/codefoundry/v1/gh_pb";
import { Code, ConnectError } from "@connectrpc/connect";
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
  | { kind: "branchPullRequests"; repoSlug: string; headRef: string }
  | { kind: "pullRequestDetail"; repoSlug: string; number: number };

// ---- Pull request detail panel (GetPullRequestDetail, ListReviewerCandidates) ------
// Reads only. Its actions are daemon commands (pr.revert, pr.review.request, pr.refresh):
// the GUI invokes them with runCommand, like the palette and the CLI.

/** A submitted review's state; "" when there is none (only requested) or unknown. */
export type ReviewStateView = "" | "pending" | "commented" | "approved" | "changes_requested" | "dismissed";
export type CommentKindView = "issue_comment" | "review" | "review_comment" | "unknown";
export type DiffSideView = "left" | "right" | null;
export type ReviewerKindView = "user" | "team";

export interface PullRequestLabelView {
  name: string;
  /** Hex without "#". */
  color: string;
}

export interface PullRequestReviewerView {
  /** User login, or "org/team". */
  login: string;
  isTeam: boolean;
  isBot: boolean;
  avatarUrl: string;
  /** The latest submitted review; "" when only requested. */
  state: ReviewStateView;
  submittedAtMs: number | null;
  /** A review request is pending (after a review too: re-requested). */
  requested: boolean;
  /** Commits landed after the latest review. */
  stale: boolean;
}

export interface PullRequestCommitView {
  sha: string;
  shortSha: string;
  headline: string;
  /** GitHub login; "" when the commit email maps to no account. */
  authorLogin: string;
  authorName: string;
  committedAtMs: number | null;
}

export interface PullRequestCommentView {
  id: string;
  kind: CommentKindView;
  author: string;
  authorIsBot: boolean;
  authorAvatarUrl: string;
  /** Markdown. */
  body: string;
  createdAtMs: number | null;
  url: string;
  /** Review comments: the file. */
  path: string;
  /** Reviews: the review's state. */
  reviewState: ReviewStateView;
  /** Review comments: the review they belong to (group a review's inline comments by it); "" otherwise. */
  reviewId: string;
}

export interface ReviewThreadView {
  id: string;
  path: string;
  /** Current line, or the original one when outdated; 0 if unknown. */
  line: number;
  side: DiffSideView;
  isResolved: boolean;
  isOutdated: boolean;
  /** The first 20, oldest first. */
  comments: PullRequestCommentView[];
  commentsTruncated: boolean;
}

/** A check with its lifecycle, for the detail panel's checks list. */
export interface CheckView extends CheckRunView {
  /** Lower case GitHub status ("completed", "in_progress", "queued", ...); "" if unknown. */
  status: string;
  description: string;
  startedAtMs: number | null;
  completedAtMs: number | null;
}

export interface PullRequestDetailView {
  pullRequest: PullRequestView;
  body: string;
  labels: PullRequestLabelView[];
  /** The first 20; labelsTruncated says there are more. */
  labelsTruncated: boolean;
  /** Requested first, then most recent review first. */
  reviewers: PullRequestReviewerView[];
  /** More than 50 latest reviews or pending requests exist than reviewers was built from. */
  reviewersTruncated: boolean;
  /** The last 100, oldest first; commitCount counts all. */
  commits: PullRequestCommitView[];
  commitCount: number;
  /**
   * Issue comments and reviews, oldest first. Inline comments are in reviewThreads, and so
   * are reviews that only carried them (COMMENTED, empty body): those are left out here.
   */
  comments: PullRequestCommentView[];
  /** Covers both streams: more than 100 issue comments or more than 100 reviews exist. */
  commentsTruncated: boolean;
  reviewThreads: ReviewThreadView[];
  reviewThreadsTruncated: boolean;
  /** Every check on the head commit, failed first. The rollup is pullRequest.checks. */
  checks: CheckView[];
  /** checks is incomplete: a page beyond the first failed (lastError says why) or there are too many. */
  checksTruncated: boolean;
  mergeCommitSha: string;
  mergedBy: string;
  closedAtMs: number | null;
  /** GitHub's node id. */
  nodeId: string;
  /** Write access: may request reviewers and revert. */
  viewerCanUpdate: boolean;
  /** "admin" | "maintain" | "write" | "triage" | "read" | "". */
  viewerPermission: string;
  fetchedAtMs: number | null;
  /** The last fetch's error when this is the cached copy, or why checks is incomplete. */
  lastError: string;
}

export interface ReviewerCandidateView {
  id: string;
  kind: ReviewerKindView;
  /** User login, or "org/team". */
  login: string;
  name: string;
  avatarUrl: string;
  isRequested: boolean;
}

export interface ReviewerCandidatesView {
  /** Requested first, then by login; the author is left out. */
  candidates: ReviewerCandidateView[];
  /** More assignable users exist than were listed (100). */
  truncated: boolean;
}

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
    case "pullRequestDetailUpdated":
      return { kind: "pullRequestDetail", repoSlug: g.value.repoSlug, number: g.value.number };
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

// ---- Pull request detail panel ------------------------------------------------------

const reviewStates: Record<PullRequestReviewState, ReviewStateView> = {
  [PullRequestReviewState.UNSPECIFIED]: "",
  [PullRequestReviewState.PENDING]: "pending",
  [PullRequestReviewState.COMMENTED]: "commented",
  [PullRequestReviewState.APPROVED]: "approved",
  [PullRequestReviewState.CHANGES_REQUESTED]: "changes_requested",
  [PullRequestReviewState.DISMISSED]: "dismissed",
};

const commentKinds: Record<PullRequestCommentKind, CommentKindView> = {
  [PullRequestCommentKind.UNSPECIFIED]: "unknown",
  [PullRequestCommentKind.ISSUE_COMMENT]: "issue_comment",
  [PullRequestCommentKind.REVIEW]: "review",
  [PullRequestCommentKind.REVIEW_COMMENT]: "review_comment",
};

const diffSides: Record<DiffSide, DiffSideView> = {
  [DiffSide.UNSPECIFIED]: null,
  [DiffSide.LEFT]: "left",
  [DiffSide.RIGHT]: "right",
};

const reviewerKinds: Record<ReviewerKind, ReviewerKindView> = {
  [ReviewerKind.UNSPECIFIED]: "user",
  [ReviewerKind.USER]: "user",
  [ReviewerKind.TEAM]: "team",
};

function toCommentView(c: PullRequestComment): PullRequestCommentView {
  return {
    id: c.id,
    kind: commentKinds[c.kind],
    author: c.author,
    authorIsBot: c.authorIsBot,
    authorAvatarUrl: c.authorAvatarUrl,
    body: c.body,
    createdAtMs: ms(c.createdAt),
    url: c.url,
    path: c.path,
    reviewState: reviewStates[c.reviewState],
    reviewId: c.reviewId,
  };
}

function toCheckView(c: CheckRun): CheckView {
  return {
    ...toCheckRunView(c),
    status: enumName(CheckStatus, c.status),
    description: c.description,
    startedAtMs: ms(c.startedAt),
    completedAtMs: ms(c.completedAt),
  };
}

export function toPullRequestDetailView(d: PullRequestDetail): PullRequestDetailView {
  return {
    pullRequest: toPullRequestView(d.pullRequest ?? create(PullRequestSchema)),
    body: d.body,
    labels: d.labels.map((l) => ({ name: l.name, color: l.color })),
    labelsTruncated: d.labelsTruncated,
    reviewers: d.reviewers.map((r) => ({
      login: r.login,
      isTeam: r.isTeam,
      isBot: r.isBot,
      avatarUrl: r.avatarUrl,
      state: reviewStates[r.state],
      submittedAtMs: ms(r.submittedAt),
      requested: r.requested,
      stale: r.stale,
    })),
    reviewersTruncated: d.reviewersTruncated,
    commits: d.commits.map((c) => ({
      sha: c.sha,
      shortSha: c.sha.slice(0, 7),
      headline: c.headline,
      authorLogin: c.authorLogin,
      authorName: c.authorName,
      committedAtMs: ms(c.committedAt),
    })),
    commitCount: d.commitCount,
    comments: d.comments.map(toCommentView),
    commentsTruncated: d.commentsTruncated,
    reviewThreads: d.reviewThreads.map((t) => ({
      id: t.id,
      path: t.path,
      line: t.line,
      side: diffSides[t.side],
      isResolved: t.isResolved,
      isOutdated: t.isOutdated,
      comments: t.comments.map(toCommentView),
      commentsTruncated: t.commentsTruncated,
    })),
    reviewThreadsTruncated: d.reviewThreadsTruncated,
    checks: d.checks.map(toCheckView),
    checksTruncated: d.checksTruncated,
    mergeCommitSha: d.mergeCommitSha,
    mergedBy: d.mergedBy,
    closedAtMs: ms(d.closedAt),
    nodeId: d.nodeId,
    viewerCanUpdate: d.viewerCanUpdate,
    viewerPermission: d.viewerPermission,
    fetchedAtMs: ms(d.fetchedAt),
    lastError: d.lastError,
  };
}

export function toReviewerCandidateView(c: ReviewerCandidate): ReviewerCandidateView {
  return { id: c.id, kind: reviewerKinds[c.kind], login: c.login, name: c.name, avatarUrl: c.avatarUrl, isRequested: c.isRequested };
}

/** GetPullRequestDetail: served from the daemon's cache unless refresh (see GhService). */
export async function getPullRequestDetail(
  repoSlug: string,
  number: number,
  refresh = false,
  conn: DaemonConnection = daemon,
  signal?: AbortSignal,
): Promise<PullRequestDetailView> {
  const c = await conn.client(GhService);
  try {
    const r = await c.getPullRequestDetail({ repoSlug, number, refresh }, { signal });
    return toPullRequestDetailView(r.detail ?? create(PullRequestDetailSchema));
  } catch (err) {
    // The resource keeps only a message: mark NOT_FOUND so views can tell it apart.
    if (err instanceof ConnectError && err.code === Code.NotFound) throw new Error(NOT_FOUND_PREFIX + err.rawMessage, { cause: err });
    throw err;
  }
}

const NOT_FOUND_PREFIX = "not found: ";

/** Whether a detail read's error message (errorMessage of what getPullRequestDetail threw) is NOT_FOUND. */
export function isNotFoundMessage(message: string | null | undefined): boolean {
  return (message ?? "").startsWith(NOT_FOUND_PREFIX);
}

/** The new pull request in pr.revert's result JSON (RevertPullRequestResponse); null if it has none. */
export function parseRevertResult(resultJson: string): { number: number; url: string } | null {
  try {
    const v = JSON.parse(resultJson) as { number?: unknown; url?: unknown };
    const number = Number(v.number);
    if (!Number.isInteger(number) || number <= 0) return null;
    return { number, url: typeof v.url === "string" ? v.url : "" };
  } catch {
    return null;
  }
}

export async function listReviewerCandidates(repoSlug: string, number: number, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<ReviewerCandidatesView> {
  const c = await conn.client(GhService);
  const r = await c.listReviewerCandidates({ repoSlug, number }, { signal });
  return { candidates: r.candidates.map(toReviewerCandidateView), truncated: r.truncated };
}
