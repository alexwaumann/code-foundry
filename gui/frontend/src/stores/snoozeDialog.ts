import { create } from "zustand";
import { snoozeThread } from "./threadActions";
import { useThreadsStore } from "./threads";

/**
 * The custom snooze dialog ("Pick a date and time…" in the snooze menus,
 * components/snooze/SnoozeDialog.tsx): which thread it snoozes. The dialog invokes
 * session.snooze itself (snoozeThread); it adds no user action of its own.
 */
interface SnoozeDialogState {
  open: boolean;
  threadId: string;
  /** Incremented on every open, so the dialog's body starts fresh. */
  seq: number;
}

export const useSnoozeDialogStore = create<SnoozeDialogState>()(() => ({ open: false, threadId: "", seq: 0 }));

/**
 * Opens the dialog for a thread. Deferred, so the menu that picked "Pick a date and time…"
 * finishes closing (and handing focus back) before the dialog takes it.
 */
export function openSnoozeDialog(threadId: string): void {
  queueMicrotask(() => {
    useSnoozeDialogStore.setState((s) => ({ open: true, threadId, seq: s.seq + 1 }));
  });
}

export function closeSnoozeDialog(): void {
  useSnoozeDialogStore.setState({ open: false });
}

/**
 * session.snooze's presenter (the palette, a chord): a snoozed thread is unsnoozed, any
 * other opens the custom dialog, since the command needs a time the palette would not ask
 * for (until is optional, so it is not prompted). False without such a thread, so the
 * command falls back to its default presentation.
 */
export function presentSnooze(threadId: string): boolean {
  const s = useThreadsStore.getState().byId[threadId];
  if (!s) return false;
  if (s.snoozedUntilMs !== null) void snoozeThread(threadId, null);
  else openSnoozeDialog(threadId);
  return true;
}
