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

/** Current time, re-rendering every periodMs. */
export function useNow(periodMs = 1000): number {
  return useSyncExternalStore(
    (cb) => subscribe(periodMs, cb),
    () => clock(periodMs).now,
  );
}
