import { create } from "zustand";
import { isSnoozed } from "@/lib/snooze";
import { snoozeThread } from "./threadActions";
import { useThreadsStore } from "./threads";

/**
 * The custom snooze dialog ("Pick a date and time…" in the snooze menus,
 * components/snooze/SnoozeDialog.tsx): which thread it snoozes. The dialog invokes
 * thread.snooze itself (snoozeThread; given several threads from the sidebar's selection, one
 * thread.snooze --ids: stores/bulkThreadActions.ts); it adds no user action of its own.
 */
interface SnoozeDialogState {
  open: boolean;
  threadId: string;
  /** The sidebar's selection when it snoozes several threads at once (the first is `threadId`); [] for one. */
  ids: readonly string[];
  /** Incremented on every open, so the dialog's body starts fresh. */
  seq: number;
}

export const useSnoozeDialogStore = create<SnoozeDialogState>()(() => ({ open: false, threadId: "", ids: [], seq: 0 }));

/**
 * Opens the dialog for a thread. Deferred, so the menu that picked "Pick a date and time…"
 * finishes closing (and handing focus back) before the dialog takes it.
 */
export function openSnoozeDialog(threadId: string): void {
  queueMicrotask(() => {
    useSnoozeDialogStore.setState((s) => ({ open: true, threadId, ids: [], seq: s.seq + 1 }));
  });
}

/** Opens the dialog for several threads (the sidebar's bulk menu), deferred as openSnoozeDialog. */
export function openSnoozeDialogFor(ids: readonly string[]): void {
  const first = ids[0];
  if (first === undefined) return;
  if (ids.length === 1) {
    openSnoozeDialog(first);
    return;
  }
  queueMicrotask(() => {
    useSnoozeDialogStore.setState((s) => ({ open: true, threadId: first, ids: [...ids], seq: s.seq + 1 }));
  });
}

export function closeSnoozeDialog(): void {
  useSnoozeDialogStore.setState({ open: false });
}

/**
 * thread.snooze's presenter (the palette, a chord): a snoozed or saved thread is
 * unsnoozed, any other opens the custom dialog (which offers Save for later too), since the command needs a time the palette would not ask
 * for (until is optional, so it is not prompted). False without such a thread, so the
 * command falls back to its default presentation.
 */
export function presentSnooze(threadId: string): boolean {
  const s = useThreadsStore.getState().byId[threadId];
  if (!s) return false;
  if (isSnoozed(s)) void snoozeThread(threadId, null);
  else openSnoozeDialog(threadId);
  return true;
}
