/**
 * What a dashboard row can say about a pull request while its detail is on its way
 * (docs/notes/pr-open-instant.md), as pure data. The header needs nothing the row lacks; the
 * readiness box shows only what the detail would say too. The verdict stays out: it hangs on
 * write access, auto-merge and the conversations, none of them in a row, so a seeded box never
 * says Ready to merge. So do the buttons: every action waits for the detail.
 */
import type { DashboardView, PullRequestDetailView, PullRequestReviewerView, PullRequestView, ReviewStateView } from "@/api/gh";
import { fresher } from "@/components/sidebar/linkedPrTag";
import { pullRequestKey } from "@/stores/gh";
import { readiness, type Readiness, type ReadinessRow, type RowId } from "./readiness";

/** The dashboard's lists, all of them: a pull request opened from any of them finds its row. */
export const dashboardLists = (d: DashboardView): readonly (readonly PullRequestView[])[] => [d.authored, d.reviewRequested, d.reviewed, d.recentlyMerged, d.projectOpen.pullRequests, d.projectMerged.pullRequests];

/**
 * The freshest row of key (pullRequestKey) in the lists: one pull request can sit in two, the
 * search behind the other having lagged a merge. A poll's partial row, which is a fingerprint
 * with no title, and a state this GUI cannot name are no row at all.
 */
export function freshestRow(lists: readonly (readonly PullRequestView[])[], key: string): PullRequestView | null {
  let best: PullRequestView | null = null;
  for (const list of lists) {
    for (const pr of list) {
      if (!pr.partial && pr.state !== "unknown" && pullRequestKey(pr.repoSlug, pr.number) === key) best = fresher(best, pr);
    }
  }
  return best;
}

const REVIEW_STATES: readonly ReviewStateView[] = ["pending", "commented", "approved", "changes_requested", "dismissed"];

const reviewState = (s: string): ReviewStateView => REVIEW_STATES.find((r) => r === s) ?? "";

/** The reviewers the detail would list, from the row's latest reviews and pending requests (avatars aside). */
function seedReviewers(pr: PullRequestView): PullRequestReviewerView[] {
  const person = { isTeam: false, isBot: false, avatarUrl: "" };
  const requested = new Set(pr.reviewRequests.map((l) => l.toLowerCase()));
  const reviewed = new Set(pr.latestReviews.map((r) => r.author.toLowerCase()));
  return [
    ...pr.reviewRequests.filter((l) => !reviewed.has(l.toLowerCase())).map((login) => ({ ...person, login, isTeam: login.includes("/"), state: "" as const, submittedAtMs: null, requested: true, stale: false })),
    ...pr.latestReviews.map((r) => ({ ...person, login: r.author, state: reviewState(r.state), submittedAtMs: r.submittedAtMs, requested: requested.has(r.author.toLowerCase()), stale: pr.headSha !== "" && r.commitSha !== pr.headSha })),
  ];
}

/**
 * A row as a detail with everything else empty, for the header and seedReadiness only. It
 * grants nothing: viewerCanUpdate is false, and no action is ever drawn from it.
 */
export function seedDetail(pr: PullRequestView): PullRequestDetailView {
  return {
    pullRequest: pr,
    body: "",
    labels: [],
    labelsTruncated: false,
    reviewers: seedReviewers(pr),
    reviewersTruncated: false,
    commits: [],
    commitCount: 0,
    comments: [],
    commentsTruncated: false,
    reviewThreads: [],
    reviewThreadsTruncated: false,
    checks: [],
    checksTruncated: false,
    mergeCommitSha: "",
    mergedBy: "",
    closedAtMs: null,
    nodeId: "",
    viewerCanUpdate: false,
    mergeMethods: [],
    autoMergeEnabled: false,
    autoMergeMethod: null,
    autoMergeAllowed: false,
    defaultBranch: "",
    viewerPermission: "",
    fetchedAtMs: null,
    lastError: "",
    fetchFailed: false,
    refreshing: false,
  };
}

export interface SeedReadiness {
  /** Null for an open pull request: the verdict waits for the detail. */
  headline: Readiness["headline"] | null;
  /** Without their buttons. */
  rows: ReadinessRow[];
  /** An open pull request: Review ▾ and Merge are on their way. */
  footerPending: boolean;
}

/** Rows that read the fields only a poll's full fetch fills in; a summary-only row has none of them. */
const FULL_ROW_ONLY: ReadonlySet<RowId> = new Set<RowId>(["review", "review-request", "conflicts", "behind", "mergeable"]);

/**
 * readiness() on a seedDetail, keeping what the row knows. "Blocked by branch protection" goes:
 * it is what is left once every other reason is ruled out, and the conversations cannot be yet.
 */
export function seedReadiness(d: PullRequestDetailView, viewer: string, now: number): SeedReadiness {
  const pr = d.pullRequest;
  const r = readiness(d, viewer, false, now);
  const open = pr.state === "open";
  const rows = r.rows.filter((row) => row.id !== "blocked" && (pr.mergeState !== "" || !open || !FULL_ROW_ONLY.has(row.id))).map((row) => ({ ...row, action: null, task: null }));
  return { headline: open ? null : r.headline, rows, footerPending: open };
}
