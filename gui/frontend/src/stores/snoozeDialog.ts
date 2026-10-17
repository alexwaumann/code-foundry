import { create } from "zustand";
import { snoozeSession } from "./threadActions";
import { useSessionsStore } from "./threads";

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

/**
 * session.snooze's presenter (the palette, a chord): a snoozed thread is unsnoozed, any
 * other opens the custom dialog, since the command needs a time the palette would not ask
 * for (until is optional, so it is not prompted). False without such a thread, so the
 * command falls back to its default presentation.
 */
export function presentSnooze(sessionId: string): boolean {
  const s = useSessionsStore.getState().byId[sessionId];
  if (!s) return false;
  if (s.snoozedUntilMs !== null) void snoozeSession(sessionId, null);
  else openSnoozeDialog(sessionId);
  return true;
}
