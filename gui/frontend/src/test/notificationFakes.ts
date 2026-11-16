/**
 * Notifications as the bell's tests need them (docs/notes/notifications-3-bell.md): a shown info
 * notification by default, and an event of them. Store-free (docs/notes/testing-gotchas.md).
 */
import type { NotificationEventView, NotificationView } from "@/api/notifications";

export function note(id: string, o: Partial<NotificationView> = {}): NotificationView {
  return {
    id,
    source: "hello",
    key: id,
    level: "info",
    timeSensitive: false,
    title: `Title ${id}`,
    body: "",
    threadId: "",
    actions: [],
    status: "shown",
    arrivedAtMs: 0,
    createdAtMs: 0,
    snoozedUntilMs: null,
    ...o,
  };
}

/** The source's event: the snapshot in the order given, the time-sensitive count from it. */
export function noteEvent(notes: NotificationView[], arrivedIds: string[] = [], updatedIds: string[] = []): NotificationEventView {
  const timeSensitive = notes.filter((n) => n.timeSensitive && n.status === "shown").length;
  return { snapshot: { notifications: notes, timeSensitive, version: 1 }, arrivedIds, updatedIds };
}
