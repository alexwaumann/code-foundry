/**
 * Which merge button's dialog is open (components/pr/MergeDialog), by the button's own id:
 * the same pull request shown in two panes opens only the dialog of the button pressed.
 * Kept here, not in the button, so a guarded confirm (a page's question) waits for it like
 * for the app's other dialogs (registerOwnDialog) instead of opening over it.
 *
 * The flag is set only while the dialog shows, so that wait never outlasts it: it is never
 * set while a merge runs on the pull request, a merge starting on it (from anywhere) clears
 * it, and the button clears it when it stops showing (it unmounts; MergeButton). Cleared
 * means gone: a refused merge does not bring the dialog back.
 */
import { create } from "zustand";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { registerOwnDialog } from "./confirm";
import { pullRequestKey } from "./gh";
import { usePrPanelStore } from "./prPanel";

interface MergeDialogState {
  /** The open dialog: its merge button and its pull request (pullRequestKey); null when none is open. */
  open: { button: string; pr: string } | null;
}

export const useMergeDialogStore = create<MergeDialogState>()(() => ({ open: null }));

registerOwnDialog(useMergeDialogStore, (s) => s.open !== null);

// A merge started on the open dialog's pull request: the dialog asks for one, so it shuts.
usePrPanelStore.subscribe((s) => {
  const open = useMergeDialogStore.getState().open;
  if (open && s.merging[open.pr] !== undefined) useMergeDialogStore.setState({ open: null });
});

/** Opens button's dialog for ref; nothing while a merge runs on ref. */
export function openMergeDialog(button: string, ref: PrRef): void {
  const pr = pullRequestKey(ref.slug, ref.number);
  if (usePrPanelStore.getState().merging[pr] !== undefined) return;
  useMergeDialogStore.setState({ open: { button, pr } });
}

/** Closes button's dialog (another button's stays open). */
export function closeMergeDialog(button: string): void {
  if (useMergeDialogStore.getState().open?.button === button) useMergeDialogStore.setState({ open: null });
}

/** Whether button's dialog is open. */
export function useMergeDialogOpen(button: string): boolean {
  return useMergeDialogStore((s) => s.open?.button === button);
}
