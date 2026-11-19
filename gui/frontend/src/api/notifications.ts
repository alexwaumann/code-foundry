/**
 * The bell's notifications (docs/notes/notifications-1-store.md, notifications-3-bell.md): what
 * plugins and `notification.post` post, one per source and key. NotificationService only reads;
 * the EventService notification source carries the whole snapshot on connect and per change, with
 * the ids that arrived (a toast) apart from those only updated (none). Dismissing, snoozing, acting
 * and clearing are the notification.* commands. The only file that uses the generated
 * notification types.
 */
import {
  NotificationLevel,
  NotificationStatus,
  type Notification,
  type NotificationAction,
  type NotificationEvent,
  type NotificationSnapshot,
} from "@/gen/codefoundry/v1/notification_pb";
import { ms } from "./timestamp";

/** How serious it is; there is no success level. */
export type NotificationLevelView = "info" | "warning" | "error";

/**
 * Where an active notification is: shown in the bell, snoozed, or scheduled (waiting for its
 * show_at). The snapshot holds only active ones; the closed states are List's with include_closed.
 */
export type NotificationStatusView = "shown" | "snoozed" | "scheduled" | "dismissed" | "withdrawn" | "resolved";

/** What a button does; the daemon runs it (`notification.act`), the GUI only names it. */
export type NotificationActionKind = "command" | "send" | "start" | "open" | "unknown";

/** A plugin's button on a notification. The first is the primary. */
export interface NotificationActionView {
  label: string;
  kind: NotificationActionKind;
  /** Pressing it resolves the notification (it leaves the bell once the action ran). */
  resolves: boolean;
  /** An open action's URL; "" for the other kinds. */
  url: string;
}

export interface NotificationView {
  /** "n-" + 12 hex digits: what the notification.* verbs take. */
  id: string;
  /** The plugin that posted it, or "command" (notification.post). */
  source: string;
  key: string;
  level: NotificationLevelView;
  timeSensitive: boolean;
  title: string;
  body: string;
  /** The thread it is about; "" for none. */
  threadId: string;
  actions: NotificationActionView[];
  status: NotificationStatusView;
  /** When it was last shown (its post, its show_at, the end of a snooze); null while scheduled. */
  arrivedAtMs: number | null;
  createdAtMs: number | null;
  snoozedUntilMs: number | null;
  /** The user has seen it since it last arrived (the bell's panel showed it, or they acted on it). */
  seen: boolean;
}

/** Every active notification in the daemon's order: shown first (time-sensitive, then newest), then snoozed and scheduled. */
export interface NotificationSnapshotView {
  notifications: NotificationView[];
  /** The shown time-sensitive ones: the dock badge's share. */
  timeSensitive: number;
  /** The shown ones the user has not seen: the bell's corner badge shows while there are any. 0 from a daemon that does not keep seen. */
  unseen: number;
  version: number;
}

/** The source's event: the snapshot, and which ids the change made arrive or only updated. Both empty on connect. */
export interface NotificationEventView {
  snapshot: NotificationSnapshotView;
  arrivedIds: string[];
  updatedIds: string[];
}

function toLevel(l: NotificationLevel): NotificationLevelView {
  if (l === NotificationLevel.ERROR) return "error";
  if (l === NotificationLevel.WARNING) return "warning";
  return "info";
}

/** Partial: a newer daemon's status this build does not know reads as shown. */
const STATUS: Partial<Record<NotificationStatus, NotificationStatusView>> = {
  [NotificationStatus.UNSPECIFIED]: "shown",
  [NotificationStatus.SHOWN]: "shown",
  [NotificationStatus.SNOOZED]: "snoozed",
  [NotificationStatus.SCHEDULED]: "scheduled",
  [NotificationStatus.DISMISSED]: "dismissed",
  [NotificationStatus.WITHDRAWN]: "withdrawn",
  [NotificationStatus.RESOLVED]: "resolved",
};

function toAction(a: NotificationAction): NotificationActionView {
  const k = a.kind;
  const kind: NotificationActionKind = k.case === undefined ? "unknown" : k.case;
  return { label: a.label, kind, resolves: a.resolves, url: k.case === "open" ? k.value.url : "" };
}

export function toNotificationView(n: Notification): NotificationView {
  return {
    id: n.id,
    source: n.source,
    key: n.key,
    level: toLevel(n.level),
    timeSensitive: n.timeSensitive,
    title: n.title,
    body: n.body,
    threadId: n.threadId,
    actions: n.actions.map(toAction),
    status: STATUS[n.status] ?? "shown",
    arrivedAtMs: ms(n.arrivedAt),
    createdAtMs: ms(n.createdAt),
    snoozedUntilMs: ms(n.snoozedUntil),
    seen: n.seen,
  };
}

export function toNotificationSnapshotView(s: NotificationSnapshot | undefined): NotificationSnapshotView {
  return {
    notifications: (s?.notifications ?? []).map(toNotificationView),
    timeSensitive: s?.timeSensitive ?? 0,
    unseen: s?.unseen ?? 0,
    version: Number(s?.version ?? 0n),
  };
}

export function toNotificationEventView(ev: NotificationEvent): NotificationEventView {
  return { snapshot: toNotificationSnapshotView(ev.snapshot), arrivedIds: [...ev.arrivedIds], updatedIds: [...ev.updatedIds] };
}
