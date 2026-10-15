import type { PullRequestDetailView, PullRequestReviewerView } from "@/api/gh";
import type { Tone } from "./model";

/**
 * The header's Review menu and its composer (ReviewButton, PrReviewComposer): what each
 * verdict says and requires, who may give it, and the viewer's own latest review.
 * pr.review's verdict arg names them; GitHub's events are APPROVE, REQUEST_CHANGES and
 * COMMENT (docs/notes/pr-review-submit-2-gui.md).
 */
export type Verdict = "approve" | "request-changes" | "comment";

export const VERDICTS: readonly Verdict[] = ["approve", "request-changes", "comment"];

export interface VerdictSpec {
  /** The menu item's title, and the submit button's label. */
  title: string;
  /** The menu item's one-line hint. */
  hint: string;
  /** The composer's label, e.g. "Approve #139". */
  label: (n: number) => string;
  tone: Tone;
  /** GitHub (and the daemon) refuse a blank body: the submit button waits for text. */
  bodyRequired: boolean;
  /** The composer's hint while a required body is blank. */
  emptyHint: string;
  placeholder: string;
  /** Why it is disabled on the viewer's own pull request ("" when it is not). */
  ownReason: string;
}

export const VERDICT_SPECS: Record<Verdict, VerdictSpec> = {
  approve: {
    title: "Approve",
    hint: "Submit an approving review, with an optional note.",
    label: (n) => `Approve #${String(n)}`,
    tone: "success",
    bodyRequired: false,
    emptyHint: "",
    placeholder: "Say why, or leave it empty…",
    ownReason: "You cannot approve your own pull request.",
  },
  "request-changes": {
    title: "Request changes",
    hint: "Block merging until your points are addressed.",
    label: (n) => `Request changes on #${String(n)}`,
    tone: "failure",
    bodyRequired: true,
    emptyHint: "Say what should change",
    placeholder: "What has to change before this merges…",
    ownReason: "Not on your own pull request.",
  },
  comment: {
    title: "Comment",
    hint: "General feedback without a verdict.",
    label: (n) => `Comment on #${String(n)}`,
    tone: "neutral",
    bodyRequired: true,
    emptyHint: "Write a comment",
    placeholder: "Leave general feedback…",
    ownReason: "",
  },
};

/** The composer's keys hint while it can submit: narrow enough for a 280px panel. */
export const REVIEW_KEYS_HINT = "⌘⏎ submit · esc cancel";
/** The composer's hint while pr.review runs. */
export const REVIEW_SENDING_HINT = "Submitting…";

/** Whether the composer may submit this text (an approval needs none). */
export function canSubmit(verdict: Verdict, text: string): boolean {
  return !VERDICT_SPECS[verdict].bodyRequired || text.trim() !== "";
}

/** The composer's footer hint: what it waits for, else the keys. */
export function composerHint(verdict: Verdict, text: string, sending: boolean): string {
  if (sending) return REVIEW_SENDING_HINT;
  return canSubmit(verdict, text) ? REVIEW_KEYS_HINT : VERDICT_SPECS[verdict].emptyHint;
}

/** Same GitHub login (logins are case-insensitive); "" matches nothing. */
export function sameLogin(a: string, b: string): boolean {
  return a !== "" && b !== "" && a.toLowerCase() === b.toLowerCase();
}

/** The verdicts GitHub refuses here, with the reason: approving or requesting changes on your own pull request. */
export function disabledVerdicts(author: string, viewer: string): Partial<Record<Verdict, string>> {
  if (!sameLogin(author, viewer)) return {};
  const out: Partial<Record<Verdict, string>> = {};
  for (const v of VERDICTS) if (VERDICT_SPECS[v].ownReason) out[v] = VERDICT_SPECS[v].ownReason;
  return out;
}

/**
 * Whether the header offers Review: an open pull request (drafts too) whose repository the
 * viewer can write to, like the reviewer picker. Merged and closed ones get nothing.
 */
export function reviewVisible(d: Pick<PullRequestDetailView, "viewerCanUpdate"> & { pullRequest: Pick<PullRequestDetailView["pullRequest"], "state"> }): boolean {
  return d.viewerCanUpdate && d.pullRequest.state === "open";
}

export type YourReview = "approved" | "changes_requested" | "commented";

export interface YourReviewSpec {
  label: string;
  tone: Tone;
}

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

/** pr.review's args. The body is trimmed (the daemon trims it too); an empty approval sends none. */
export function reviewArgs(ref: { slug: string; number: number }, verdict: Verdict, body: string): Record<string, string> {
  const b = body.trim();
  return { "repo-slug": ref.slug, number: String(ref.number), verdict, ...(b === "" ? {} : { body: b }) };
}
