import { useSyncExternalStore } from "react";

/**
 * Shared wall clocks for relative times ("updated 8s ago"). One interval per period,
 * running only while something subscribes, so a page of rows costs one timer.
 */
const clocks = new Map<number, { now: number; subs: Set<() => void>; timer: ReturnType<typeof setInterval> | null }>();

function clock(periodMs: number) {
  let c = clocks.get(periodMs);
  if (!c) {
    c = { now: Date.now(), subs: new Set(), timer: null };
    clocks.set(periodMs, c);
  }
  return c;
}

function subscribe(periodMs: number, cb: () => void): () => void {
  const c = clock(periodMs);
  c.subs.add(cb);
  if (!c.timer) {
    c.now = Date.now();
    c.timer = setInterval(() => {
      c.now = Date.now();
      for (const s of c.subs) s();
    }, periodMs);
  }
  return () => {
    c.subs.delete(cb);
    if (c.subs.size === 0 && c.timer) {
      clearInterval(c.timer);
      c.timer = null;
    }
  };
}

/**
 * One subscribe function per period. useSyncExternalStore resubscribes whenever it gets a
 * new function; an inline one did so on every render, and when the caller was the
 * period's only subscriber each resubscribe restarted the clock with a new `now`, which
 * rendered again: an endless loop (seen with a lone useNow(30_000) in the side panel).
 */
const subscribers = new Map<number, (cb: () => void) => () => void>();

function subscriberFor(periodMs: number): (cb: () => void) => () => void {
  let s = subscribers.get(periodMs);
  if (!s) {
    s = (cb) => subscribe(periodMs, cb);
    subscribers.set(periodMs, s);
  }
  return s;
}

/** Current time, re-rendering every periodMs. */
export function useNow(periodMs = 1000): number {
  return useSyncExternalStore(subscriberFor(periodMs), () => clock(periodMs).now);
}
