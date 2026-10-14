import { create } from "zustand";

/**
 * The custom snooze dialog ("Pick a date and time…" in the snooze menus,
 * components/snooze/SnoozeDialog.tsx): which thread it snoozes. The dialog invokes
 * session.snooze itself (snoozeSession); it adds no user action of its own.
 */
interface SnoozeDialogState {
  open: boolean;
  sessionId: string;
  /** Incremented on every open, so the dialog's body starts fresh. */
  seq: number;
}

export const useSnoozeDialogStore = create<SnoozeDialogState>()(() => ({ open: false, sessionId: "", seq: 0 }));

/**
 * Opens the dialog for a thread. Deferred, so the menu that picked "Pick a date and time…"
 * finishes closing (and handing focus back) before the dialog takes it.
 */
export function openSnoozeDialog(sessionId: string): void {
  queueMicrotask(() => {
    useSnoozeDialogStore.setState((s) => ({ open: true, sessionId, seq: s.seq + 1 }));
  });
}

export function closeSnoozeDialog(): void {
  useSnoozeDialogStore.setState({ open: false });
}
