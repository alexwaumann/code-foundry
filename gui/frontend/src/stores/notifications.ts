/**
 * The bell's notifications (docs/notes/notifications-3-bell.md), fed only by the EventService
 * notification source: its snapshot on every connect is the whole list (so a reconnect needs no
 * List), and every change sends the whole list again with the ids that arrived. The bell's open
 * state lives here too, since an arrival toasts only while the bell is shut. Toasts are
 * stores/notificationToasts.ts's; the dock reads `seq` and `timeSensitiveArrived`.
 */
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import type { NotificationEventView, NotificationSnapshotView, NotificationView } from "@/api/notifications";
import { bellCount, shownNotifications, threadMark, threadNotifications, timeSensitiveArrivals, unseenIds, type BellCount, type ThreadMark } from "@/lib/notifications";

interface NotificationsState {
  /** The last snapshot; null until the source sends one. */
  snapshot: NotificationSnapshotView | null;
  /** Events applied so far: a new one is a change the dock looks at. */
  seq: number;
  /** The last event's time-sensitive arrivals that are shown (what bounces the dock). */
  timeSensitiveArrived: readonly string[];
  /** The bell's list is open. */
  open: boolean;
}

export const useNotificationsStore = create<NotificationsState>()(() => ({ snapshot: null, seq: 0, timeSensitiveArrived: [], open: false }));

/** The notification source's handler (stores/events.ts). */
export function applyNotificationEvent(ev: NotificationEventView): void {
  useNotificationsStore.setState((s) => ({ snapshot: ev.snapshot, seq: s.seq + 1, timeSensitiveArrived: timeSensitiveArrivals(ev) }));
}

/** Opens or shuts the bell's list (the bell, Escape, a card's thread link, the "N more" toast). */
export function setBellOpen(open: boolean): void {
  if (useNotificationsStore.getState().open !== open) useNotificationsStore.setState({ open });
}

/** The ids the bell lists, in the daemon's order. */
export function useShownNotificationIds(): readonly string[] {
  return useNotificationsStore(useShallow((s) => shownNotifications(s.snapshot).map((n) => n.id)));
}

/** One notification by id; undefined once it left the snapshot. */
export function useNotification(id: string): NotificationView | undefined {
  return useNotificationsStore((s) => s.snapshot?.notifications.find((n) => n.id === id));
}

/** The bell's count, its tones and whether one is unseen (the corner badge). */
export function useBellCount(): BellCount {
  return useNotificationsStore(useShallow((s) => bellCount(s.snapshot)));
}

/**
 * While the bell's list is open: its unseen shown ones, as one key ("" while shut or with none).
 * A new arrival changes the key even when two events land in one render.
 */
export function useUnseenWhileOpen(): string {
  return useNotificationsStore((s) => (s.open ? unseenIds(s.snapshot).join(" ") : ""));
}

/**
 * A thread's mark on its sidebar row (lib/notifications threadMark). A thread no notification
 * names reads the one shared NO_MARK, so a change to other threads' notifications never
 * re-renders its row.
 */
export function useThreadMark(threadId: string): ThreadMark {
  return useNotificationsStore(useShallow((s) => threadMark(s.snapshot, threadId)));
}

/** The ids of a thread's shown notifications, in the daemon's order (its row's hover card). */
export function useThreadNotificationIds(threadId: string): readonly string[] {
  return useNotificationsStore(useShallow((s) => threadNotifications(s.snapshot, threadId).map((n) => n.id)));
}

/** A notification shown now, read outside React (a toast's button). */
export function shownNotification(id: string): NotificationView | undefined {
  return shownNotifications(useNotificationsStore.getState().snapshot).find((n) => n.id === id);
}

/** Test helper: forgets everything. */
export function resetNotifications(): void {
  useNotificationsStore.setState({ snapshot: null, seq: 0, timeSensitiveArrived: [], open: false });
}
