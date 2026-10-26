import type { PullRequestView } from "@/api/gh";

/** Why a pull request needs the viewer's review. */
export type NeedsWhy = "requested" | "requested_team" | "new_commits" | "dismissed";

/** The viewer's verdict on a pull request they reviewed and need not look at again yet. */
export type Verdict = "approved" | "changes_requested" | "commented";

export interface NeedsRow {
  pr: PullRequestView;
  why: NeedsWhy;
}

export interface ReviewedRow {
  pr: PullRequestView;
  verdict: Verdict;
}

export interface ReviewQueue {
  needs: NeedsRow[];
  reviewed: ReviewedRow[];
}

const sameLogin = (a: string, b: string): boolean => a !== "" && a.toLowerCase() === b.toLowerCase();

/** Newest updated first; unknown times last. Stable, so the daemon's order breaks ties. */
const byUpdated = (a: { pr: PullRequestView }, b: { pr: PullRequestView }): number => (b.pr.updatedAtMs ?? -Infinity) - (a.pr.updatedAtMs ?? -Infinity);

const prId = (p: PullRequestView): string => `${p.repoSlug.toLowerCase()}#${String(p.number)}`;

/**
 * Splits the dashboard's review lists into what needs the viewer's review and what they
 * reviewed that waits on the author (docs/notes/prs-inbox-2-gui.md):
 *
 * - every pull request in `requested` needs review: "requested_team" when its known
 *   requests do not name the viewer (GitHub's search matched a team request), else
 *   "requested";
 * - one only in `reviewed` needs review when the viewer's latest review is not on the
 *   head commit ("new_commits"; a review without a commit counts, since GitHub has none
 *   when a force-push dropped the reviewed commit) or was dismissed ("dismissed");
 * - otherwise it is reviewed, with that review's verdict (a pending or missing review
 *   reads as "commented").
 *
 * Both lists are newest updated first.
 */
export function reviewQueue(requested: readonly PullRequestView[], reviewed: readonly PullRequestView[], viewer: string): ReviewQueue {
  const needs: NeedsRow[] = [];
  const done: ReviewedRow[] = [];
  const seen = new Set<string>();
  for (const pr of requested) {
    if (seen.has(prId(pr))) continue;
    seen.add(prId(pr));
    // Requests not known (a partial row, no viewer yet): plainly "requested".
    const viaTeam = viewer !== "" && pr.reviewRequests.length > 0 && !pr.reviewRequests.some((r) => sameLogin(r, viewer));
    needs.push({ pr, why: viaTeam ? "requested_team" : "requested" });
  }
  for (const pr of reviewed) {
    if (seen.has(prId(pr))) continue;
    seen.add(prId(pr));
    const mine = pr.latestReviews.find((r) => sameLogin(r.author, viewer));
    if (!mine) {
      done.push({ pr, verdict: "commented" });
      continue;
    }
    // An unknown head (a partial row) cannot make a review stale.
    if (pr.headSha !== "" && mine.commitSha !== pr.headSha) needs.push({ pr, why: "new_commits" });
    else if (mine.state === "dismissed") needs.push({ pr, why: "dismissed" });
    else done.push({ pr, verdict: mine.state === "approved" || mine.state === "changes_requested" ? mine.state : "commented" });
  }
  return { needs: needs.sort(byUpdated), reviewed: done.sort(byUpdated) };
}

/** How many pull requests need the viewer's review (the sidebar's count). */
export function needsReviewCount(requested: readonly PullRequestView[], reviewed: readonly PullRequestView[], viewer: string): number {
  return reviewQueue(requested, reviewed, viewer).needs.length;
}

export const needsLabel: Record<NeedsWhy, string> = {
  requested: "Requested",
  requested_team: "Requested · via team",
  new_commits: "Re-review · new commits",
  dismissed: "Re-review · review dismissed",
};

export const verdictLabel: Record<Verdict, string> = {
  approved: "You approved",
  changes_requested: "You requested changes",
  commented: "You commented",
};
