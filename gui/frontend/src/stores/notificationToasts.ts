/**
 * The arrival toast (docs/notes/notifications-3-bell.md): a notification that arrives while the
 * bell is shut shows as a toast through notify, with its level, its title, its body and its
 * buttons, each running notification.act. The toast closing (by time, its ×, or a swipe) leaves
 * the notification in the bell. The first ARRIVAL_TOAST_CAP arrivals of a burst toast one by
 * one, the rest as one "N more notifications" toast whose Open opens the bell (lib/notifications.ts). A time-sensitive
 * one stays until closed; another closes after ARRIVAL_TOAST_MS (twice the default: it has
 * buttons to reach), and both have the × (closing it is not dismissing it). A toast whose
 * notification left the bell (acted on, dismissed, withdrawn) goes with it, so no button acts on
 * a notification that is gone.
 */
import type { NotificationEventView, NotificationView } from "@/api/notifications";
import { arrivalToasts, NO_BURST, shownNotifications, type ArrivalBurst } from "@/lib/notifications";
import { dismissNotice, notify, type Notice } from "@/lib/notify";
import { actOnNotification } from "./notificationActions";
import { setBellOpen, useNotificationsStore } from "./notifications";

/** How long a normal arrival's toast stays (sonner pauses it while hovered). */
export const ARRIVAL_TOAST_MS = 8000;

/** The toast id of a notification's arrival: it arrives again in place. */
export function arrivalToastId(id: string): string {
  return `notification:${id}`;
}

export const MORE_TOAST_ID = "notification:more";

/** The notice an arrival shows. */
export function arrivalNotice(n: NotificationView): Notice {
  return {
    id: arrivalToastId(n.id),
    level: n.level,
    title: n.title,
    description: n.body || undefined,
    buttons: n.actions.map((a, i) => ({
      label: a.label,
      onClick: () => {
        void actOnNotification(n.id, i, a.label);
      },
    })),
    sticky: n.timeSensitive,
    closable: true,
    duration: n.timeSensitive ? undefined : ARRIVAL_TOAST_MS,
  };
}

/** The notice for the arrivals past the cap. */
export function moreNotice(more: number): Notice {
  return {
    id: MORE_TOAST_ID,
    level: "info",
    title: `${String(more)} more notification${more === 1 ? "" : "s"}`,
    duration: ARRIVAL_TOAST_MS,
    action: {
      label: "Open",
      onClick: () => {
        setBellOpen(true);
      },
    },
  };
}

/** Arrival toasts up now, by notification id. */
const raised = new Set<string>();
let burst: ArrivalBurst = NO_BURST;

/** The notification source's toasts (stores/events.ts), after the store took the event. */
export function raiseArrivalToasts(ev: NotificationEventView, nowMs = Date.now()): void {
  const shown = new Set(shownNotifications(ev.snapshot).map((n) => n.id));
  for (const id of raised) {
    if (shown.has(id)) continue;
    raised.delete(id);
    dismissNotice(arrivalToastId(id));
  }
  const next = arrivalToasts(burst, ev, useNotificationsStore.getState().open, nowMs);
  burst = next.burst;
  const { each, more } = next;
  for (const n of each) {
    raised.add(n.id);
    notify(arrivalNotice(n));
  }
  if (more > 0) notify(moreNotice(more));
}

/** Test helper: forgets the toasts raised. */
export function resetArrivalToasts(): void {
  raised.clear();
  burst = NO_BURST;
}
