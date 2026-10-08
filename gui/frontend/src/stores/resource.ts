import { useEffect } from "react";
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { invalidateOnTransportError } from "@/api/endpoint";
import { errorMessage, isAbort } from "@/api/stream";

/** One cached unary read. `data` survives errors (shown stale with the error). */
export interface ResourceEntry<V> {
  data: V | null;
  error: string | null;
  loading: boolean;
}

export interface Resource<V> {
  /** Entries by key. Subscribe with a narrow selector (one key). */
  store: UseBoundStore<StoreApi<{ entries: Readonly<Record<string, ResourceEntry<V>>> }>>;
  /** Declares interest in key: fetches now if first, re-fetches on invalidate. Returns release. */
  watch: (key: string) => () => void;
  /** Re-fetches key (or every key matching pred) if anything is watching it. */
  invalidate: (keyOrPred: string | ((key: string) => boolean)) => void;
  /** Keys currently watched (tests, diagnostics). */
  watched: () => string[];
}

/**
 * Interest-counted cache for daemon unary reads that change on events: a component
 * watches the key it shows, events invalidate keys, and only watched keys are fetched.
 * One fetch per key at a time; an invalidation during a fetch schedules one more.
 * `keepAliveMs` re-fetches watched keys periodically (renews daemon-side watches that
 * lapse without calls, e.g. GetBranchPullRequests and GetWorktreeDetail).
 */
export function createResource<V>(fetcher: (key: string, signal: AbortSignal) => Promise<V>, opts: { keepAliveMs?: number } = {}): Resource<V> {
  const store = create<{ entries: Readonly<Record<string, ResourceEntry<V>>> }>()(() => ({ entries: {} }));
  const interest = new Map<string, number>();
  const inflight = new Map<string, AbortController>();
  const rerun = new Set<string>();
  const timers = new Map<string, ReturnType<typeof setInterval>>();

  const patch = (key: string, p: Partial<ResourceEntry<V>>) => {
    store.setState((s) => {
      const prev = s.entries[key] ?? { data: null, error: null, loading: false };
      return { entries: { ...s.entries, [key]: { ...prev, ...p } } };
    });
  };

  const run = (key: string): void => {
    if (inflight.has(key)) {
      rerun.add(key);
      return;
    }
    const ctl = new AbortController();
    inflight.set(key, ctl);
    patch(key, { loading: true });
    fetcher(key, ctl.signal)
      .then((data) => {
        patch(key, { data, error: null, loading: false });
      })
      .catch((err: unknown) => {
        if (isAbort(err)) return;
        invalidateOnTransportError(err);
        patch(key, { error: errorMessage(err), loading: false });
      })
      .finally(() => {
        inflight.delete(key);
        if (rerun.delete(key) && interest.has(key)) run(key);
      });
  };

  return {
    store,
    watch: (key) => {
      const n = (interest.get(key) ?? 0) + 1;
      interest.set(key, n);
      if (n === 1) {
        run(key);
        if (opts.keepAliveMs) timers.set(key, setInterval(() => {
          run(key);
        }, opts.keepAliveMs));
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const left = (interest.get(key) ?? 1) - 1;
        if (left > 0) {
          interest.set(key, left);
          return;
        }
        interest.delete(key);
        clearInterval(timers.get(key));
        timers.delete(key);
      };
    },
    invalidate: (keyOrPred) => {
      for (const key of interest.keys()) {
        if (typeof keyOrPred === "string" ? key === keyOrPred : keyOrPred(key)) run(key);
      }
    },
    watched: () => [...interest.keys()],
  };
}

/** Watches key while mounted (null watches nothing) and returns its entry. */
export function useResource<V>(r: Resource<V>, key: string | null): ResourceEntry<V> | undefined {
  useEffect(() => (key === null ? undefined : r.watch(key)), [r, key]);
  return r.store((s) => (key === null ? undefined : s.entries[key]));
}
