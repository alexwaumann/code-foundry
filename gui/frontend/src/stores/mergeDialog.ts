/**
 * Which merge button's dialog is open (components/pr/MergeDialog), by the button's own id:
 * the same pull request shown in two panes opens only the dialog of the button pressed.
 * Kept here, not in the button, so a guarded confirm (a page's question) waits for it like
 * for the app's other dialogs (registerOwnDialog) instead of opening over it.
 */
import { create } from "zustand";
import { registerOwnDialog } from "./confirm";

interface MergeDialogState {
  /** The open dialog's merge button; null when none is open. */
  open: string | null;
}

export const useMergeDialogStore = create<MergeDialogState>()(() => ({ open: null }));

registerOwnDialog(useMergeDialogStore, (s) => s.open !== null);

export function openMergeDialog(button: string): void {
  useMergeDialogStore.setState({ open: button });
}

/** Closes button's dialog (another button's stays open). */
export function closeMergeDialog(button: string): void {
  if (useMergeDialogStore.getState().open === button) useMergeDialogStore.setState({ open: null });
}

/** Whether button's dialog is open. */
export function useMergeDialogOpen(button: string): boolean {
  return useMergeDialogStore((s) => s.open === button);
}
