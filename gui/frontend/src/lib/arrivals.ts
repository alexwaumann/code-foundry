/**
 * The arrival tilt (docs/notes/arrival-tilt.md): an icon tilts once, briefly, when something
 * that needs the user arrives: a notification on the top bar's bell, a thread entering Needs you
 * (a permission, a question, a plan) or waking from a snooze on its sidebar row and rail icon.
 *
 * "Just arrived" is state over consecutive snapshots, never "plays on mount": what was already
 * there on the first snapshot, after a reconnect, when a row re-mounts or the sidebar changes
 * shape is not an arrival. Pure; stores/arrivals.ts feeds it and keeps the arrivals.
 */
import { Bell, BellRing } from "lucide-react";
import type { NotificationEventView } from "@/api/notifications";
import { inSidebar } from "./inSidebar";
import { shownNotifications } from "./notifications";
import { statusLine, type StatusLineKind } from "./statusLine";
import type { ThreadView } from "@/api/threads";

/** How long the tilt plays (index.css --animate-arrival-tilt); an arrival is forgotten after it. */
export const TILT_MS = 1400;

/** The status kinds that call on the user: Needs you's asks, and a woken snooze. */
const CALLING_KINDS: ReadonlySet<StatusLineKind> = new Set<StatusLineKind>(["input", "question", "plan", "snoozeEnded"]);

/** The threads list's fields the arrival reads (stores/threads ThreadsData). */
export interface ArrivalThreads {
  byId: Readonly<Record<string, ThreadView>>;
  order: readonly string[];
}

/** The user's threads that call on them now, in `order`: shown in the sidebar, not archived, asking or woken. */
export function callingIds(data: ArrivalThreads): string[] {
  return data.order.filter((id) => {
    const t = data.byId[id];
    return t !== undefined && t.archivedAtMs === null && inSidebar(t, data.byId) && CALLING_KINDS.has(statusLine(t).kind);
  });
}

export interface ArrivalState {
  /** The threads epoch `calling` was taken in; null before the first step. */
  epoch: number | null;
  /** The threads that called on the user at the last step. */
  calling: ReadonlySet<string>;
}

export const initialArrivals: ArrivalState = { epoch: null, calling: new Set() };

/**
 * One step: the threads that call on the user now and did not at the previous step of the same
 * epoch have just arrived. The first step, and the first after the epoch changes (the list
 * replaced: startup, a reconnect), only take the baseline, so nothing already there tilts. A
 * thread that stopped calling and calls again later is a new arrival; one that changes its ask
 * while still calling (a permission, then a question) is not.
 */
export function stepArrivals(state: ArrivalState, input: { epoch: number; calling: readonly string[] }): { state: ArrivalState; arrived: string[] } {
  const baseline = state.epoch !== input.epoch;
  const arrived = baseline ? [] : input.calling.filter((id) => !state.calling.has(id));
  return { state: { epoch: input.epoch, calling: new Set(input.calling) }, arrived };
}

/**
 * Whether a notification event tilts the bell: it names an arrival that is shown (one dismissed
 * or snoozed as it arrived is not). A connect's snapshot names no arrivals, so the notifications
 * there on a connect or a reconnect never tilt it.
 */
export function bellArrived(ev: NotificationEventView): boolean {
  if (ev.arrivedIds.length === 0) return false;
  const arrived = new Set(ev.arrivedIds);
  return shownNotifications(ev.snapshot).some((n) => arrived.has(n.id));
}

/** Whether an arrival at `atMs` is still tilting at `nowMs`. */
export function tilting(atMs: number | undefined | null, nowMs: number): boolean {
  return atMs != null && nowMs - atMs < TILT_MS;
}

/**
 * The tilt's classes for an icon: a bell (the top bar's Bell, a woken snooze's BellRing) swings
 * from its top, every other icon rocks about its centre. Not gated on prefers-reduced-motion: the
 * tilt says something arrived, it is not decoration (docs/notes/arrival-tilt.md).
 */
export function tiltClass(icon: unknown): string {
  return icon === Bell || icon === BellRing ? "animate-arrival-tilt origin-[50%_12%]" : "animate-arrival-tilt";
}
