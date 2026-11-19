import type { PullRequestDetailView, PullRequestReviewerView } from "@/api/gh";
import type { Tone } from "./model";

/**
 * The header's Review button and its dialog (ReviewButton, ReviewDialog): what each verdict
 * says and requires, who may give it, and the viewer's own latest review. pr.review's
 * verdict arg names them; GitHub's events are APPROVE, REQUEST_CHANGES and COMMENT
 * (docs/notes/pr-review-submit-2-gui.md, docs/notes/pr-review-dialog.md).
 */
export type Verdict = "approve" | "request-changes" | "comment";

/** The dialog's segmented control, left to right. */
export const VERDICTS: readonly Verdict[] = ["comment", "approve", "request-changes"];

export interface VerdictSpec {
  /** The segment's label. */
  title: string;
  /** The dialog's confirm button. */
  confirm: string;
  /** The Review button's words while this verdict is submitted. */
  busy: string;
  tone: Tone;
  /** GitHub (and the daemon) refuse a blank body: the confirm waits for text. */
  bodyRequired: boolean;
  /** The dialog's hint while a required body is blank. */
  emptyHint: string;
  placeholder: string;
}

export const VERDICT_SPECS: Record<Verdict, VerdictSpec> = {
  approve: {
    title: "Approve",
    confirm: "Approve",
    busy: "Approving…",
    tone: "success",
    bodyRequired: false,
    emptyHint: "",
    placeholder: "Optional comment",
  },
  "request-changes": {
    title: "Request changes",
    confirm: "Request changes",
    busy: "Requesting changes…",
    tone: "failure",
    bodyRequired: true,
    emptyHint: "Say what should change",
    placeholder: "What needs to change before this merges?",
  },
  comment: {
    title: "Comment",
    confirm: "Submit comment",
    busy: "Commenting…",
    tone: "neutral",
    bodyRequired: true,
    emptyHint: "Write a comment",
    placeholder: "Leave a comment",
  },
};

/** The dialog's keys hint while it can submit. */
export const REVIEW_KEYS_HINT = "⌘⏎ submit · esc cancel";

/** The dialog's line under the verdicts on the viewer's own pull request. */
export const OWN_PULL_REQUEST_NOTE = "You can’t approve or request changes on your own pull request.";

/** Whether the dialog may submit this text (an approval needs none). */
export function canSubmit(verdict: Verdict, text: string): boolean {
  return !VERDICT_SPECS[verdict].bodyRequired || text.trim() !== "";
}

/** The dialog's footer hint: what a blank required body waits for, else the keys. */
export function reviewHint(verdict: Verdict, text: string): string {
  return canSubmit(verdict, text) ? REVIEW_KEYS_HINT : VERDICT_SPECS[verdict].emptyHint;
}

/** Same GitHub login (logins are case-insensitive); "" matches nothing. */
export function sameLogin(a: string, b: string): boolean {
  return a !== "" && b !== "" && a.toLowerCase() === b.toLowerCase();
}

/** The verdicts GitHub refuses here: approving or requesting changes on your own pull request. An unknown viewer ("") is refused nothing. */
export function disabledVerdicts(author: string, viewer: string): readonly Verdict[] {
  return sameLogin(author, viewer) ? ["approve", "request-changes"] : [];
}

/**
 * The verdict the dialog opens on: the one left in an unsent draft, else the viewer's
 * previous review (reopening from the chip), else Comment on their own pull request and
 * Approve on anyone else's; never one GitHub would refuse here.
 */
export function initialVerdict(draft: Verdict | null, mine: YourReview | null, disabled: readonly Verdict[]): Verdict {
  for (const v of [draft, mine && YOUR_REVIEW_VERDICT[mine]]) if (v && !disabled.includes(v)) return v;
  return disabled.includes("approve") ? "comment" : "approve";
}

/**
 * Whether the readiness box offers Review: an open pull request (drafts too) whose
 * repository the viewer can write to, or whose review is requested from the viewer
 * (GitHub takes reviews from read access too; Approve and Request changes still follow
 * disabledVerdicts). Merged and closed ones get nothing.
 */
export function reviewVisible(
  d: Pick<PullRequestDetailView, "viewerCanUpdate"> & { pullRequest: Pick<PullRequestDetailView["pullRequest"], "state">; reviewers: readonly Pick<PullRequestReviewerView, "login" | "isTeam" | "requested">[] },
  viewer: string,
): boolean {
  if (d.pullRequest.state !== "open") return false;
  return d.viewerCanUpdate || reviewRequested(d.reviewers, viewer);
}

/** Whether the viewer's own review is requested (again, too): Review is then the primary button. */
export function reviewRequested(reviewers: readonly Pick<PullRequestReviewerView, "login" | "isTeam" | "requested">[], viewer: string): boolean {
  return reviewers.some((r) => r.requested && !r.isTeam && sameLogin(r.login, viewer));
}

export type YourReview = "approved" | "changes_requested" | "commented";

export interface YourReviewSpec {
  label: string;
  tone: Tone;
}

/** The verdict a review of that state gave. */
export const YOUR_REVIEW_VERDICT: Record<YourReview, Verdict> = { approved: "approve", changes_requested: "request-changes", commented: "comment" };

export const YOUR_REVIEW_SPECS: Record<YourReview, YourReviewSpec> = {
  approved: { label: "You approved", tone: "success" },
  changes_requested: { label: "You requested changes", tone: "failure" },
  commented: { label: "You commented", tone: "neutral" },
};

/**
 * The viewer's latest submitted review from the detail's reviewers (one entry per
 * reviewer, its latest review's state); null when they have none, or only a pending
 * (unsubmitted) or dismissed one: the header then shows Review.
 */
export function yourReview(reviewers: readonly Pick<PullRequestReviewerView, "login" | "isTeam" | "state">[], viewer: string): YourReview | null {
  const me = reviewers.find((r) => !r.isTeam && sameLogin(r.login, viewer));
  switch (me?.state) {
    case "approved":
    case "changes_requested":
    case "commented":
      return me.state;
    default:
      return null;
  }
}
