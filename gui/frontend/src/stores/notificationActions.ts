/**
 * What the bell's cards and the arrival toasts do: every button is a notification.* command
 * (docs/notes/notifications-3-bell.md). The bell shows each result itself (a card leaves, the
 * list empties), so no success toasts; a failure toasts at level error.
 */
import { notify } from "@/lib/notify";
import { isSnoozed } from "@/lib/snooze";
import { selectThreadAndFlag } from "./flagSurface";
import { runCommandForResult } from "./commands";
import { setBellOpen } from "./notifications";
import { useThreadsStore } from "./threads";

export const NOTIFICATION_COMMANDS = {
  dismiss: "notification.dismiss",
  snooze: "notification.snooze",
  act: "notification.act",
  clear: "notification.clear",
} as const;

/** Dismiss (the card's ×): it leaves the bell until its content changes. */
export async function dismissNotification(id: string): Promise<boolean> {
  return (await runCommandForResult(NOTIFICATION_COMMANDS.dismiss, { id }, { inView: true })) !== null;
}

/** Snooze until a time (the card's presets): it leaves the bell and arrives again then. */
export async function snoozeNotification(id: string, untilMs: number): Promise<boolean> {
  return (await runCommandForResult(NOTIFICATION_COMMANDS.snooze, { id, until: new Date(untilMs).toISOString() }, { inView: true })) !== null;
}

/**
 * Clear all: dismisses every shown one (snoozed and scheduled ones stay). No confirm: it is a
 * dismissal of alerts, like Clear flags, not a loss of the user's own work (memory.clear and
 * search.clear ask), and a source posting changed content brings a notification back.
 */
export async function clearNotifications(): Promise<boolean> {
  return (await runCommandForResult(NOTIFICATION_COMMANDS.clear, {}, { inView: true })) !== null;
}

/**
 * A plugin's button: notification.act with the action's number (1 is the primary). Quiet on
 * success from the bell and from a toast alike: what it does shows (a thread starts or gets the
 * message, the browser comes forward, the card leaves when it resolves). A failure toasts with
 * the button's name and the daemon's reason; the notification stays.
 */
export async function actOnNotification(id: string, index: number, label: string): Promise<boolean> {
  const res = await runCommandForResult(NOTIFICATION_COMMANDS.act, { id, action: String(index + 1) }, {
    quiet: true,
    expected: () => true,
    onError: (message) => {
      notify({ level: "error", title: `${label} failed`, description: message });
    },
  });
  return res !== null;
}

/**
 * The card's thread link: the thread's tab in its own space (the selection bridge runs
 * `thread.open --focus`), a preview tab for an archived or snoozed one, as the sidebar opens
 * them. The bell shuts behind it.
 */
export function goToNotificationThread(threadId: string): void {
  const t = useThreadsStore.getState().byId[threadId];
  setBellOpen(false);
  selectThreadAndFlag(threadId, { preview: t !== undefined && (t.archivedAtMs !== null || isSnoozed(t)) });
}
