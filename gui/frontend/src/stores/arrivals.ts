/**
 * The arrivals the tilt plays for (docs/notes/arrival-tilt.md; the rules are lib/arrivals.ts):
 * when the bell's last notification arrived and when each thread last started calling on the
 * user, each kept for TILT_MS and then forgotten. An icon reads its arrival time, not "I just
 * mounted": a row that re-mounts mid-tilt (a virtualized list's scroll, the rail and the
 * expanded sidebar swapping) carries on from where the tilt is, and one after it shows nothing.
 */
import { useCallback } from "react";
import { create } from "zustand";
import type { NotificationEventView } from "@/api/notifications";
import { bellArrived, callingIds, initialArrivals, stepArrivals, tiltClass, tilting, TILT_MS } from "@/lib/arrivals";
import { useThreadsStore } from "./threads";

interface ArrivalsState {
  /** When a shown notification last arrived (epoch ms); null when none is tilting the bell. */
  bell: number | null;
  /** When each thread started calling on the user, for those still tilting. */
  threads: Readonly<Record<string, number>>;
}

const none: ArrivalsState = { bell: null, threads: {} };

export const useArrivalsStore = create<ArrivalsState>()(() => none);

/** Drops the arrivals whose tilt is over. */
function prune(nowMs: number): void {
  useArrivalsStore.setState((s) => {
    const bell = tilting(s.bell, nowMs) ? s.bell : null;
    const kept = Object.entries(s.threads).filter(([, at]) => tilting(at, nowMs));
    const threads = kept.length === Object.keys(s.threads).length ? s.threads : Object.fromEntries(kept);
    return bell === s.bell && threads === s.threads ? s : { bell, threads };
  });
}

function schedulePrune(now: () => number): void {
  setTimeout(() => {
    prune(now());
  }, TILT_MS);
}

/** The notification source's arrivals (stores/events.ts): a shown arrival tilts the bell. */
export function noteNotificationArrivals(ev: NotificationEventView, now: () => number = Date.now): void {
  if (!bellArrived(ev)) return;
  useArrivalsStore.setState({ bell: now() });
  schedulePrune(now);
}

/** Starts noting the threads that start calling on the user; returns the stop function. */
export function startArrivals(now: () => number = Date.now): () => void {
  let state = initialArrivals;
  const evaluate = () => {
    const threads = useThreadsStore.getState();
    const next = stepArrivals(state, { epoch: threads.epoch, calling: callingIds(threads) });
    state = next.state;
    if (next.arrived.length === 0) return;
    const at = now();
    useArrivalsStore.setState((s) => ({ threads: { ...s.threads, ...Object.fromEntries(next.arrived.map((id) => [id, at])) } }));
    schedulePrune(now);
  };
  evaluate();
  return useThreadsStore.subscribe((s, prev) => {
    if (s.byId !== prev.byId || s.order !== prev.order || s.epoch !== prev.epoch) evaluate();
  });
}

/** What an icon spreads on itself: the tilt's classes while an arrival is kept, and its ref callback (`place`), which sets where the tilt is. */
export interface Tilt {
  className?: string;
  place: (el: Element | null) => void;
}

/**
 * An icon's tilt for an arrival at `atMs`: the animation, started as far back as the arrival is
 * (a negative delay, set as the icon mounts or the arrival changes), so a re-mount carries on
 * rather than starting over and one after TILT_MS shows nothing; a re-render does not move it.
 */
export function useTilt(atMs: number | null | undefined, icon: unknown, now: () => number = Date.now): Tilt {
  const place = useCallback(
    (el: Element | null) => {
      if (!(el instanceof SVGElement || el instanceof HTMLElement)) return;
      el.style.animationDelay = atMs == null ? "" : `${String(atMs - now())}ms`;
    },
    [atMs, now],
  );
  return { className: atMs == null ? undefined : tiltClass(icon), place };
}

/** The bell glyph's tilt. */
export function useBellTilt(icon: unknown): Tilt {
  return useTilt(useArrivalsStore((s) => s.bell), icon);
}

/** A thread's status icon's tilt (its rail icon, its row's status icon). */
export function useThreadTilt(threadId: string, icon: unknown): Tilt {
  return useTilt(useArrivalsStore((s) => s.threads[threadId]), icon);
}

/** Test helper: forgets every arrival. */
export function resetArrivals(): void {
  useArrivalsStore.setState(none, true);
}
