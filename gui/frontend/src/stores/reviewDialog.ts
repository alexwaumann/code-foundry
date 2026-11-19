/**
 * The review dialog (components/pr/ReviewDialog): which pull request it is open for, and
 * each pull request's unsent review (verdict and text). One dialog for the whole window,
 * opened from any surface showing the pull request (its header, its Diff tab). The draft
 * outlives the dialog: Cancel, Escape and a failed submit keep the text for the next open;
 * only a posted review clears it. Registered with registerOwnDialog, so a page's guarded
 * question waits for it instead of opening over it.
 */
import { create } from "zustand";
import type { Verdict } from "@/components/pr/review";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { registerOwnDialog } from "./confirm";
import { pullRequestKey } from "./gh";

export interface ReviewDraft {
  verdict: Verdict;
  text: string;
}

interface ReviewDialogState {
  /** The pull request the dialog is open for; null when it is shut. */
  open: PrRef | null;
  /** Unsent reviews by pullRequestKey. */
  drafts: Readonly<Record<string, ReviewDraft>>;
  /** The button that opened it: focus goes back there when it shuts (WebKit does not focus a clicked button). */
  opener: HTMLElement | null;
}

export const useReviewDialogStore = create<ReviewDialogState>()(() => ({ open: null, drafts: {}, opener: null }));

registerOwnDialog(useReviewDialogStore, (s) => s.open !== null);

/** The draft's verdict when its text is worth keeping (null: none). */
export function draftVerdict(ref: PrRef): Verdict | null {
  const d = useReviewDialogStore.getState().drafts[pullRequestKey(ref.slug, ref.number)];
  return d && d.text.trim() !== "" ? d.verdict : null;
}

/** Opens the dialog for ref on verdict, keeping a draft's text; `opener` takes the focus back when it shuts. */
export function openReviewDialog(ref: PrRef, verdict: Verdict, opener: HTMLElement | null = null): void {
  const key = pullRequestKey(ref.slug, ref.number);
  useReviewDialogStore.setState((s) => ({ open: { slug: ref.slug, number: ref.number }, opener, drafts: { ...s.drafts, [key]: { verdict, text: s.drafts[key]?.text ?? "" } } }));
}

/** Shuts the dialog; the draft stays. */
export function closeReviewDialog(): void {
  if (useReviewDialogStore.getState().open !== null) useReviewDialogStore.setState({ open: null });
}

export function setReviewDraft(ref: PrRef, draft: Partial<ReviewDraft>): void {
  const key = pullRequestKey(ref.slug, ref.number);
  useReviewDialogStore.setState((s) => ({ drafts: { ...s.drafts, [key]: { verdict: "comment", text: "", ...s.drafts[key], ...draft } } }));
}

/** Forgets ref's draft (its review was posted). */
export function clearReviewDraft(ref: PrRef): void {
  const key = pullRequestKey(ref.slug, ref.number);
  useReviewDialogStore.setState((s) => {
    const { [key]: _gone, ...rest } = s.drafts;
    return { drafts: rest };
  });
}
