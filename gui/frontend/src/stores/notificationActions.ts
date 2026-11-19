/**
 * What the bell's cards and the arrival toasts do: every button is a notification.* command
 * (docs/notes/notifications-3-bell.md). The bell shows each result itself (a card leaves, the
 * list empties), so no success toasts; a failure toasts at level error. They also say when the
 * bell shuts: at once for an action or the thread link, and after a dismiss, snooze or clear
 * only when that emptied the list (docs/notes/bell-close-on-action.md).
 */
import { notify } from "@/lib/notify";
import { shownNotifications } from "@/lib/notifications";
import { runCommandForResult } from "./commands";
import { setBellOpen, useNotificationsStore } from "./notifications";
import { openThread } from "./openThread";

export const NOTIFICATION_COMMANDS = {
  dismiss: "notification.dismiss",
  snooze: "notification.snooze",
  act: "notification.act",
  clear: "notification.clear",
} as const;

function shownIds(): readonly string[] {
  return shownNotifications(useNotificationsStore.getState().snapshot).map((n) => n.id);
}

/**
 * Runs a dismiss, snooze or clear, and shuts the bell when it took away every notification the
 * bell listed at the click. Decided from the click's list, since the command's result and the
 * snapshot that drops the card arrive in either order; not on a failure; and not when one
 * arrived meanwhile (it would not toast while the bell is open, so shutting would hide it). A
 * list that empties by itself (a source withdrawing) never shuts the bell: nothing calls this.
 */
async function removing(ids: readonly string[] | "all", run: () => Promise<unknown>): Promise<boolean> {
  const before = shownIds();
  const empties = ids === "all" || before.every((id) => ids.includes(id));
  const ok = (await run()) !== null;
  if (ok && empties && shownIds().every((id) => before.includes(id))) setBellOpen(false);
  return ok;
}

/** Dismiss (the card's ×): it leaves the bell until its content changes. */
export async function dismissNotification(id: string): Promise<boolean> {
  return removing([id], () => runCommandForResult(NOTIFICATION_COMMANDS.dismiss, { id }, { inView: true }));
}

/** Snooze until a time (the card's presets): it leaves the bell and arrives again then. */
export async function snoozeNotification(id: string, untilMs: number): Promise<boolean> {
  return removing([id], () => runCommandForResult(NOTIFICATION_COMMANDS.snooze, { id, until: new Date(untilMs).toISOString() }, { inView: true }));
}

/**
 * Clear all: dismisses every shown one (snoozed and scheduled ones stay). No confirm: it is a
 * dismissal of alerts, not a loss of the user's own work (memory.clear and
 * search.clear ask), and a source posting changed content brings a notification back.
 */
export async function clearNotifications(): Promise<boolean> {
  return removing("all", () => runCommandForResult(NOTIFICATION_COMMANDS.clear, {}, { inView: true }));
}

/**
 * A plugin's button: notification.act with the action's number (1 is the primary). Quiet on
 * success from the bell and from a toast alike: what it does shows (a thread starts or gets the
 * message, the browser comes forward, the card leaves when it resolves). A failure toasts with
 * the button's name and the daemon's reason; the notification stays. The bell shuts at the click,
 * not waiting for the result: the user is done with the list and the action takes them elsewhere.
 */
export async function actOnNotification(id: string, index: number, label: string): Promise<boolean> {
  setBellOpen(false);
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
  setBellOpen(false);
  openThread(threadId);
}
