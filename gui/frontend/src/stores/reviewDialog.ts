/**
 * The review dialog (components/pr/ReviewDialog): which pull request it is open for, and
 * each pull request's unsent review (verdict and text). One dialog for the whole window,
 * opened from any surface showing the pull request (its header, its Diff tab). The draft
 * outlives the dialog: Cancel, Escape and a failed submit keep the text for the next open;
 * only a posted review clears it. Registered with registerOwnDialog, so a page's guarded
 * question waits for it instead of opening over it.
 *
 * `open` is set only while the dialog can show (reviewDialogShows), so that wait never
 * outlasts it: openReviewDialog does nothing otherwise, and a change in what decides it (the
 * detail, the viewer, a review being sent) shuts the dialog where it lands, in the stores
 * that hold them. Shut means gone: the pull request taking reviews again does not bring
 * the dialog back.
 */
import { create } from "zustand";
import type { PullRequestDetailView } from "@/api/gh";
import { reviewVisible, type Verdict } from "@/components/pr/review";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { registerOwnDialog } from "./confirm";
import { pullRequestDetailResource, pullRequestKey, VIEWER_KEY, viewerResource } from "./gh";
import { usePrPanelStore } from "./prPanel";

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

/**
 * Whether the dialog can show for a pull request: its detail read, `viewer` may review it
 * (reviewVisible: open, and theirs to update or their review requested), and no review of
 * it being sent (`busy`). The dialog's view and this store decide it the same way.
 */
export function reviewDialogShows(detail: PullRequestDetailView | null, viewer: string, busy: boolean): boolean {
  return detail !== null && reviewVisible(detail, viewer) && !busy;
}

/** reviewDialogShows for ref, from the stores now. */
function showsNow(ref: PrRef): boolean {
  const key = pullRequestKey(ref.slug, ref.number);
  const detail = pullRequestDetailResource.store.getState().entries[key]?.data ?? null;
  const viewer = viewerResource.store.getState().entries[VIEWER_KEY]?.data?.login ?? "";
  return reviewDialogShows(detail, viewer, usePrPanelStore.getState().reviewing[key] !== undefined);
}

/** Shuts the dialog when what it shows went (merged meanwhile, the review sent from elsewhere). */
function shutIfGone(): void {
  const open = useReviewDialogStore.getState().open;
  if (open && !showsNow(open)) useReviewDialogStore.setState({ open: null });
}

pullRequestDetailResource.store.subscribe(shutIfGone);
viewerResource.store.subscribe(shutIfGone);
usePrPanelStore.subscribe(shutIfGone);

/** The draft's verdict when its text is worth keeping (null: none). */
export function draftVerdict(ref: PrRef): Verdict | null {
  const d = useReviewDialogStore.getState().drafts[pullRequestKey(ref.slug, ref.number)];
  return d && d.text.trim() !== "" ? d.verdict : null;
}

/**
 * Opens the dialog for ref on verdict, keeping a draft's text; `opener` takes the focus back
 * when it shuts. Nothing when it cannot show (reviewDialogShows).
 */
export function openReviewDialog(ref: PrRef, verdict: Verdict, opener: HTMLElement | null = null): void {
  if (!showsNow(ref)) return;
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
