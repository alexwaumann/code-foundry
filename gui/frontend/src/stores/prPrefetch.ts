import { useEffect, useMemo, type PointerEvent } from "react";
import { pullRequestDetailResource, usePollStore } from "./gh";

/**
 * Warms a pull request's detail while the pointer or the keyboard cursor rests on its row, so
 * the click finds it read. Each prefetch costs a GitHub request out of the budget the poll
 * shares, so this stays small: only the row last rested on counts (a sweep cancels as it
 * goes), a scroll cancels what the pointer armed, and a dwell past the caps is dropped, never
 * queued. The click itself reads as it always did: nothing here is needed for it to work.
 */

/** How long a row is rested on before it counts. */
export const PREFETCH_DWELL_MS = 150;
/** Prefetches at a time. */
export const PREFETCH_MAX_CONCURRENT = 2;
/** Prefetches started in any PREFETCH_WINDOW_MS: a slow sweep still dwells on every row. */
export const PREFETCH_MAX_PER_WINDOW = 8;
export const PREFETCH_WINDOW_MS = 60_000;
/** How long a failed prefetch stops them all: what failed one will fail the next. */
export const PREFETCH_BACKOFF_MS = 60_000;

/** el: the row under the pointer, which a scroll cancels; null: the keyboard's cursor, which scrolls its row into view. */
let armed: { key: string; el: Element | null; timer: ReturnType<typeof setTimeout> } | null = null;
let running = 0;
let started: number[] = [];
let backoffUntil = 0;
let listening = false;

function disarm(): void {
  if (armed) clearTimeout(armed.timer);
  armed = null;
}

/** Rows passing under a still pointer enter it one after another; none of them is a dwell. */
function onScroll(e: Event): void {
  if (armed?.el && e.target instanceof Node && e.target.contains(armed.el)) disarm();
}

/** The poll failing means a rate limit, a pause or no network: reads would fail or spend what is left. */
export function prefetchHeld(): boolean {
  return usePollStore.getState().lastError !== "" || Date.now() < backoffUntil;
}

function prefetch(key: string): void {
  const entry = pullRequestDetailResource.store.getState().entries[key];
  if (entry?.data || entry?.loading || prefetchHeld() || running >= PREFETCH_MAX_CONCURRENT) return;
  const now = Date.now();
  started = started.filter((t) => now - t < PREFETCH_WINDOW_MS);
  if (started.length >= PREFETCH_MAX_PER_WINDOW) return;
  started.push(now);
  running++;
  void pullRequestDetailResource.readOnce(key).finally(() => {
    running--;
    if (pullRequestDetailResource.store.getState().entries[key]?.error) backoffUntil = Date.now() + PREFETCH_BACKOFF_MS;
  });
}

/** Starts key's dwell, replacing any other. */
export function armPrefetch(key: string, el: Element | null = null): void {
  disarm();
  if (!listening) {
    listening = true;
    document.addEventListener("scroll", onScroll, { capture: true, passive: true });
  }
  armed = {
    key,
    el,
    timer: setTimeout(() => {
      armed = null;
      prefetch(key);
    }, PREFETCH_DWELL_MS),
  };
}

/** Ends key's dwell, if it is the one running. */
export function disarmPrefetch(key: string): void {
  if (armed?.key === key) disarm();
}

/** Tests: forgets the counts and the backoff. */
export function resetPrefetch(): void {
  disarm();
  running = 0;
  started = [];
  backoffUntil = 0;
}

/** A pull request row's pointer handlers (key: pullRequestKey; null: none yet). A row that unmounts under the pointer ends its dwell. */
export function usePrPrefetch(key: string | null) {
  useEffect(
    () => () => {
      if (key !== null) disarmPrefetch(key);
    },
    [key],
  );
  return useMemo(
    () => ({
      onPointerEnter: (e: PointerEvent<HTMLElement>) => {
        if (key !== null) armPrefetch(key, e.currentTarget);
      },
      onPointerLeave: () => {
        if (key !== null) disarmPrefetch(key);
      },
    }),
    [key],
  );
}
