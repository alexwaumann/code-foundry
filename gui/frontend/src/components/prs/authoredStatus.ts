import type { PullRequestView } from "@/api/gh";

export type AuthoredStatusKind =
  | "conflicts"
  | "ci_failing"
  | "changes_requested"
  | "behind"
  | "blocked"
  | "draft"
  | "awaiting_review"
  | "no_reviewers"
  | "ci_running"
  | "ready"
  | "open";

export type StatusTone = "error" | "warning" | "success" | "neutral";

export interface AuthoredStatus {
  kind: AuthoredStatusKind;
  label: string;
  tone: StatusTone;
  /** Sort rank, worst first: 1–5 need the author's action. */
  rank: number;
}

/** Statuses up to this rank need the author's action and sort first. */
export const ACTION_RANK = 5;

const READY_STATES = new Set(["clean", "has_hooks", "unstable"]);

type Input = Pick<PullRequestView, "draft" | "mergeable" | "mergeState" | "checks" | "review" | "reviewRequests" | "latestReviews">;

/**
 * One status for a pull request the viewer authored, the worst that applies
 * (docs/notes/prs-inbox-2-gui.md): Conflicts, CI failing, Changes requested, Behind base,
 * Blocked, Draft, Awaiting review · N, No reviewers, CI running, Ready to merge; "Open"
 * when none does (GitHub has not computed the merge state yet).
 *
 * Blocked is for a block nothing below explains: GitHub reports BLOCKED for a draft, a
 * missing required review and required checks still running too, and those read better
 * as their own status.
 */
export function authoredStatus(pr: Input): AuthoredStatus {
  const c = pr.checks;
  const failing = c.failed > 0 || c.state === "failure" || c.state === "error";
  const running = !failing && (c.pending > 0 || c.state === "pending" || c.state === "expected");
  if (pr.mergeable === "conflicting" || pr.mergeState === "dirty") return { kind: "conflicts", label: "Conflicts", tone: "error", rank: 1 };
  if (failing) return { kind: "ci_failing", label: "CI failing", tone: "error", rank: 2 };
  if (pr.review === "changes_requested") return { kind: "changes_requested", label: "Changes requested", tone: "error", rank: 3 };
  if (pr.mergeState === "behind") return { kind: "behind", label: "Behind base", tone: "warning", rank: 4 };
  if (pr.mergeState === "blocked" && !pr.draft && pr.review !== "review_required" && !running) {
    return { kind: "blocked", label: "Blocked", tone: "warning", rank: 5 };
  }
  if (pr.draft) return { kind: "draft", label: "Draft", tone: "neutral", rank: 6 };
  const requests = pr.reviewRequests.length;
  if (requests > 0 && pr.review !== "approved") return { kind: "awaiting_review", label: `Awaiting review · ${String(requests)}`, tone: "neutral", rank: 7 };
  if (requests === 0 && pr.latestReviews.length === 0 && (pr.review === "review_required" || pr.review === null)) {
    return { kind: "no_reviewers", label: "No reviewers", tone: "neutral", rank: 8 };
  }
  if (running) return { kind: "ci_running", label: "CI running", tone: "neutral", rank: 9 };
  if ((pr.review === "approved" || pr.review === null) && READY_STATES.has(pr.mergeState)) return { kind: "ready", label: "Ready to merge", tone: "success", rank: 10 };
  return { kind: "open", label: "Open", tone: "neutral", rank: 11 };
}

export interface AuthoredRow {
  pr: PullRequestView;
  status: AuthoredStatus;
}

/** The viewer's open pull requests with their status: action needed first (worst first), then newest updated. */
export function authoredRows(prs: readonly PullRequestView[]): AuthoredRow[] {
  const rows = prs.map((pr) => ({ pr, status: authoredStatus(pr) }));
  const bucket = (r: AuthoredRow) => (r.status.rank <= ACTION_RANK ? r.status.rank : ACTION_RANK + 1);
  return rows.sort((a, b) => bucket(a) - bucket(b) || (b.pr.updatedAtMs ?? -Infinity) - (a.pr.updatedAtMs ?? -Infinity));
}
