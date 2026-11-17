/**
 * The bell's rules, pure (docs/notes/notifications-3-bell.md): which notifications the bell
 * lists and counts, how a source is named, and which arrivals toast.
 */
import type { NotificationEventView, NotificationSnapshotView, NotificationView } from "@/api/notifications";

/** The source `notification.post` posts as (the CLI and agents), named this on a card. */
export const COMMAND_SOURCE = "command";
export const COMMAND_SOURCE_LABEL = "Code Foundry";

/** The daemon's own source for plugins that stopped (docs/notes/notifications-plugin-health.md). */
export const PLUGINS_SOURCE = "plugins";
export const PLUGINS_SOURCE_LABEL = "Plugins";

/**
 * Arrivals toasted one by one per burst; past it, one "N more notifications" toast (its count
 * kept up to date in place) opens the bell. Two: a burst never stacks more than three toasts,
 * and each of the two keeps its buttons.
 */
export const ARRIVAL_TOAST_CAP = 2;

/**
 * Arrivals within this long of the previous one are one burst: a plugin's first poll posts
 * several notifications one call (one event) at a time, and several snoozes can end in one tick.
 */
export const ARRIVAL_BURST_MS = 2000;

const NONE: readonly NotificationView[] = [];

/** The notifications the bell lists, in the daemon's order (time-sensitive first, then the newest). Snoozed and scheduled ones wait outside it. */
export function shownNotifications(s: NotificationSnapshotView | null): readonly NotificationView[] {
  if (!s) return NONE;
  return s.notifications.filter((n) => n.status === "shown");
}

/** The bell's count, and whether any shown one is time-sensitive (the count takes the attention tone). */
export function bellCount(s: NotificationSnapshotView | null): { count: number; urgent: boolean } {
  const shown = shownNotifications(s);
  return { count: shown.length, urgent: shown.some((n) => n.timeSensitive) };
}

/** A card's source: "Code Foundry" for notification.post, "Plugins" for the daemon's plugin health, else the plugin's display name, else the source as given. */
export function sourceLabel(source: string, pluginDisplayName: string | undefined): string {
  if (source === COMMAND_SOURCE) return COMMAND_SOURCE_LABEL;
  if (source === PLUGINS_SOURCE) return PLUGINS_SOURCE_LABEL;
  return pluginDisplayName || source;
}

/** The burst the arrival toasts are counting. */
export interface ArrivalBurst {
  /** When the burst's last arrival came; null before any. */
  lastAtMs: number | null;
  /** Arrivals toasted one by one in it. */
  toasted: number;
  /** Arrivals past the cap in it: the "N more" toast's count. */
  more: number;
}

export const NO_BURST: ArrivalBurst = { lastAtMs: null, toasted: 0, more: 0 };

export interface ArrivalToasts {
  burst: ArrivalBurst;
  /** Toasted one each, in the snapshot's order. */
  each: NotificationView[];
  /** The "N more notifications" toast's count now (shown or updated in place); 0 for none. */
  more: number;
}

/**
 * What an event toasts: its arrivals still shown in its snapshot (one that arrived and was
 * already dismissed or snoozed is not), in the snapshot's order. Within a burst (arrivals less
 * than ARRIVAL_BURST_MS apart) the first ARRIVAL_TOAST_CAP toast one each and the rest count
 * into one "N more" toast; a time-sensitive one always toasts on its own and takes a place. Nothing while the bell is open (the list shows them), and nothing for
 * updated ids. A connect's snapshot names no arrivals, so the notifications there on a connect
 * or a reconnect are the baseline and never toast.
 */
export function arrivalToasts(burst: ArrivalBurst, ev: NotificationEventView, bellOpen: boolean, nowMs: number, cap = ARRIVAL_TOAST_CAP): ArrivalToasts {
  if (bellOpen || ev.arrivedIds.length === 0) return { burst, each: [], more: 0 };
  const arrived = new Set(ev.arrivedIds);
  const shown = shownNotifications(ev.snapshot).filter((n) => arrived.has(n.id));
  if (shown.length === 0) return { burst, each: [], more: 0 };
  const fresh = burst.lastAtMs === null || nowMs - burst.lastAtMs >= ARRIVAL_BURST_MS;
  const from = fresh ? NO_BURST : burst;
  // A time-sensitive arrival always toasts on its own (it also bounces the dock); the rest fill what room is left.
  const urgent = shown.filter((n) => n.timeSensitive);
  const room = Math.max(0, cap - from.toasted - urgent.length);
  const rest = shown.filter((n) => !n.timeSensitive);
  const each = shown.filter((n) => n.timeSensitive || rest.indexOf(n) < room);
  const extra = shown.length - each.length;
  const next = { lastAtMs: nowMs, toasted: from.toasted + each.length, more: from.more + extra };
  return { burst: next, each, more: extra > 0 ? next.more : 0 };
}

/** The event's arrivals that are shown and time-sensitive: what bounces the dock. */
export function timeSensitiveArrivals(ev: NotificationEventView): string[] {
  if (ev.arrivedIds.length === 0) return [];
  const arrived = new Set(ev.arrivedIds);
  return shownNotifications(ev.snapshot)
    .filter((n) => n.timeSensitive && arrived.has(n.id))
    .map((n) => n.id);
}

/** The tone of a thread's mark (docs/notes/notifications-4-row-mark.md): error, the attention tone, or the row's muted one. */
export type ThreadMarkTone = "error" | "warning" | "muted";

/** A thread's mark on its sidebar row: how many shown notifications name it, and their tone. */
export interface ThreadMark {
  count: number;
  tone: ThreadMarkTone;
}

/** No notification names the thread: one shared value, so a selector over it never changes. */
export const NO_MARK: ThreadMark = { count: 0, tone: "muted" };

/** The shown notifications naming a thread, in the daemon's order. Snoozed and scheduled ones wait outside it, as they do the bell. */
export function threadNotifications(s: NotificationSnapshotView | null, threadId: string): readonly NotificationView[] {
  if (!s || threadId === "") return NONE;
  const own = s.notifications.filter((n) => n.status === "shown" && n.threadId === threadId);
  return own.length === 0 ? NONE : own;
}

/**
 * A thread's mark: the count of its shown notifications; the error tone when one is an error,
 * else the attention tone when one is time-sensitive or a warning, else muted.
 */
export function threadMark(s: NotificationSnapshotView | null, threadId: string): ThreadMark {
  const own = threadNotifications(s, threadId);
  if (own.length === 0) return NO_MARK;
  const tone: ThreadMarkTone = own.some((n) => n.level === "error") ? "error" : own.some((n) => n.timeSensitive || n.level === "warning") ? "warning" : "muted";
  return { count: own.length, tone };
}
