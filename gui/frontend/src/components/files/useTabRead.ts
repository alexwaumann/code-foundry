/**
 * Reads for the File and Diff tabs (docs/notes/file-viewer-3-tabs.md). The data lives in
 * the tab's component state, so only the visible tab holds it and unmounting frees it; no
 * cache beyond the tab. A tab mounts each time it becomes the active one (GroupBody keys
 * its body by tab), so switching back to it reads again. Besides that, a read runs again
 * on the refresh button, when the window becomes visible, when the daemon recomputes the
 * file's worktree (worktree_detail_updated, seen through the worktree detail resource),
 * and when the visible thread's Edit, MultiEdit, Write or NotebookEdit on the file
 * finishes; and whenever the file's stamp changes (useFileChanges).
 * Event-driven reads are debounced.
 */
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { errorMessage, isAbort, onVisibilityChange } from "@/api/stream";
import type { ThreadItemView } from "@/api/thread";
import { parseObject } from "@/lib/toolSummary";
import { fileWatcher, type WatchOptions } from "@/stores/fileStamps";
import { useResource } from "@/stores/resource";
import { useThreadStore, type ThreadLog } from "@/stores/thread";
import { useUiStore } from "@/stores/ui";
import { detailKey, worktreeDetailResource } from "@/stores/worktreeDetail";

export interface TabRead<T> {
  /** The last good read; kept while a re-read runs or after it fails. */
  data: T | null;
  /** The last read's failure; null after a good one. */
  error: string | null;
  /** A read for the current key (or a reload) has not answered yet. */
  loading: boolean;
  /** Reads again now (stable). */
  reload: () => void;
  /** Takes `data` as the last good read, for what the tab itself just wrote (stable). */
  replace: (data: T) => void;
}

export interface TabReadCacheEntry<T> {
  data: T;
  stale: boolean;
  bytes: number;
}

/**
 * Bounded LRU cache shared across mounts of a tab read (Diff file switches, tab switches,
 * SourcePicker refs). Invalidated entries remain readable for immediate stale-while-revalidate
 * rendering and trigger a background fetch on next mount/visit.
 */
export interface TabReadCache<T> {
  /** Read-only lookup (safe during render). */
  peek: (key: string) => TabReadCacheEntry<T> | undefined;
  /** Lookup that refreshes LRU recency. */
  get: (key: string) => TabReadCacheEntry<T> | undefined;
  /** Stores fresh data and refreshes LRU recency, evicting the oldest entries past max/maxBytes. */
  set: (key: string, data: T) => void;
  /** Marks matching entries (or all entries) stale so the next read revalidates. */
  invalidate: (keyOrPred?: string | ((key: string) => boolean)) => void;
  /** Removes matching entries (or all entries) completely. */
  clear: (keyOrPred?: string | ((key: string) => boolean)) => void;
  size: () => number;
}

export function createTabReadCache<T>({ max = 32, maxBytes, sizeOf }: { max?: number; maxBytes?: number; sizeOf?: (data: T) => number } = {}): TabReadCache<T> {
  const map = new Map<string, TabReadCacheEntry<T>>();
  let totalBytes = 0;
  const match = (key: string, keyOrPred?: string | ((k: string) => boolean)): boolean => {
    if (keyOrPred === undefined) return true;
    return typeof keyOrPred === "string" ? key === keyOrPred : keyOrPred(key);
  };
  const del = (key: string) => {
    const prev = map.get(key);
    if (!prev) return;
    totalBytes -= prev.bytes;
    map.delete(key);
  };
  return {
    peek: (key) => map.get(key),
    get: (key) => {
      const hit = map.get(key);
      if (!hit) return undefined;
      map.delete(key);
      map.set(key, hit);
      return hit;
    },
    set: (key, data) => {
      del(key);
      const bytes = sizeOf ? Math.max(0, sizeOf(data)) : 0;
      map.set(key, { data, stale: false, bytes });
      totalBytes += bytes;
      while (map.size > max || (maxBytes !== undefined && map.size > 1 && totalBytes > maxBytes)) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        del(oldest);
      }
    },
    invalidate: (keyOrPred) => {
      if (typeof keyOrPred === "string") {
        const hit = map.get(keyOrPred);
        if (hit) hit.stale = true;
        return;
      }
      for (const [k, entry] of map) {
        if (match(k, keyOrPred)) entry.stale = true;
      }
    },
    clear: (keyOrPred) => {
      if (keyOrPred === undefined) {
        map.clear();
        totalBytes = 0;
        return;
      }
      if (typeof keyOrPred === "string") {
        del(keyOrPred);
        return;
      }
      for (const k of [...map.keys()]) {
        if (keyOrPred(k)) del(k);
      }
    },
    size: () => map.size,
  };
}

export interface UseTabReadOptions<T> {
  cache?: TabReadCache<T>;
  /**
   * "revalidate" (default): render cached data immediately while revalidating in the background.
   * "fresh": skip fetching when a non-stale cache entry exists; still fetches on miss, stale
   * entry, or explicit reload().
   */
  mode?: "revalidate" | "fresh";
}

/** How long event-driven re-reads wait for more events. */
export const REFRESH_DEBOUNCE_MS = 250;

/**
 * Runs `read` for `key` on mount, whenever the key changes (the previous read is
 * aborted), and on reload(). `read` may change identity freely: the latest one runs.
 * With `opts.cache`, cached data renders immediately on remount/revisit (and skips
 * re-fetching when `mode: "fresh"` and not stale).
 */
export function useTabRead<T>(key: string, read: (signal: AbortSignal) => Promise<T>, opts?: UseTabReadOptions<T>): TabRead<T> {
  const cache = opts?.cache;
  const mode = opts?.mode ?? "revalidate";
  const [reloadReq, setReloadReq] = useState<{ key: string; n: number }>({ key: "", n: 0 });
  const force = reloadReq.key === key ? reloadReq.n : 0;
  const [lastKey, setLastKey] = useState(key);
  const [state, setState] = useState<{ key: string; force: number; data: T | null; error: string | null }>(() => {
    const hit = cache?.peek(key);
    return hit
      ? { key, force: mode === "fresh" && !hit.stale ? 0 : -1, data: hit.data, error: null }
      : { key: "", force: -1, data: null, error: null };
  });
  const cached = cache?.peek(key);
  const freshHit = force === 0 && mode === "fresh" && cached !== undefined && !cached.stale;
  if (lastKey !== key) {
    setLastKey(key);
    if (freshHit) setState({ key, force, data: cached.data, error: null });
  }
  const keyRef = useRef(key);
  const cacheRef = useRef(cache);
  useEffect(() => {
    keyRef.current = key;
    cacheRef.current = cache;
  }, [key, cache]);
  const run = useEffectEvent((signal: AbortSignal) => read(signal));
  useEffect(() => {
    const hit = cache?.get(key);
    if (force === 0 && mode === "fresh" && hit !== undefined && !hit.stale) {
      return;
    }
    const c = new AbortController();
    run(c.signal)
      .then((data) => {
        if (c.signal.aborted) return;
        cache?.set(key, data);
        setState({ key, force, data, error: null });
      })
      .catch((err: unknown) => {
        if (c.signal.aborted || isAbort(err)) return;
        const entry = cache?.peek(key);
        setState((s) => ({ key, force, data: s.key === key ? s.data : (entry?.data ?? null), error: errorMessage(err) }));
      });
    return () => {
      c.abort();
    };
  }, [key, force, cache, mode]);
  const reload = useCallback(() => {
    const k = keyRef.current;
    cacheRef.current?.invalidate(k);
    setReloadReq((r) => ({ key: k, n: (r.key === k ? r.n : 0) + 1 }));
  }, []);
  const replace = useCallback((data: T) => {
    const k = keyRef.current;
    cacheRef.current?.set(k, data);
    setState((s) => ({ ...s, key: k, data, error: null }));
  }, []);
  // An external cache.invalidate() marks the cache stale for future mounts/switches without
  // flipping a mounted hook into loading:true while no fetch is in flight (which would starve
  // useThrottled's busy guard).
  const same = state.key === key;
  const settled = same && state.force === force;
  return {
    data: freshHit ? cached.data : same ? state.data : (cached?.data ?? null),
    error: freshHit ? null : same ? state.error : null,
    loading: freshHit ? false : !settled,
    reload,
    replace,
  };
}

/** `f` (stable) debounced by `ms`; the pending call is dropped on unmount. */
export function useDebounced(f: () => void, ms = REFRESH_DEBOUNCE_MS): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(f, ms);
  }, [f, ms]);
}

/**
 * `f` at most once per `ms` under a stream of calls, for a read that must not fall behind: the
 * first call starts the wait and later ones join it, where a debounce would start over and a
 * stream with gaps under `ms` would never let it run. While `busy` (a read not answered yet) the
 * wait goes on: running `f` would abort that read, and if every read is slower than `ms` none
 * would ever answer. The returned function is stable; the pending call is dropped on unmount.
 */
export function useThrottled(f: () => void, ms = REFRESH_DEBOUNCE_MS, busy = false): () => void {
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const now = useRef({ f, ms, busy });
  useEffect(() => {
    now.current = { f, ms, busy };
  });
  useEffect(
    () => () => {
      clearTimeout(timer.current);
    },
    [],
  );
  return useCallback(() => {
    if (timer.current !== undefined) return;
    const tick = () => {
      if (now.current.busy) {
        timer.current = setTimeout(tick, now.current.ms);
        return;
      }
      timer.current = undefined;
      now.current.f();
    };
    timer.current = setTimeout(tick, now.current.ms);
  }, []);
}

/** Calls `onVisible` when the window becomes visible again (the app comes back from the background). */
export function useOnWindowVisible(onVisible: () => void): void {
  const fire = useEffectEvent(onVisible);
  useEffect(
    () =>
      onVisibilityChange((visible) => {
        if (visible) fire();
      }),
    [],
  );
}

/**
 * Calls `onChange` when the daemon recomputes a worktree's detail (worktree_detail_updated
 * invalidates worktreeDetailResource, whose new computed time lands here). Watching the
 * detail also keeps the daemon recomputing that worktree, which is what makes it send the
 * event. Null watches nothing (a file outside any project).
 */
export function useWorktreeChanges(projectId: string, worktree: string | null, onChange: () => void): void {
  const entry = useResource(worktreeDetailResource, projectId && worktree ? detailKey(projectId, worktree) : null);
  const stamp = entry?.data?.computedAtMs ?? null;
  const seen = useRef<number | null>(null);
  const fire = useEffectEvent(onChange);
  useEffect(() => {
    if (stamp === null) return;
    const before = seen.current;
    seen.current = stamp;
    if (before !== null && before !== stamp) fire();
  }, [stamp]);
}

const EDIT_TOOLS = new Set(["Edit", "MultiEdit", "Write", "NotebookEdit"]);
/** A finished file-editing tool call's path, by item (items keep their identity while unchanged). */
const editPaths = new WeakMap<ThreadItemView, string>();

function editPath(it: ThreadItemView): string {
  if (it.kind !== "tool" || it.status !== "done" || it.isError || !EDIT_TOOLS.has(it.name)) return "";
  let p = editPaths.get(it);
  if (p === undefined) {
    const input = parseObject(it.inputJson);
    const v = input.file_path ?? input.notebook_path;
    p = typeof v === "string" ? v : "";
    editPaths.set(it, p);
  }
  return p;
}

/** How many finished edits of `path` a thread's log holds (the selector's answer: a number). */
export function editsOf(log: ThreadLog | undefined, path: string): number {
  if (!log || !path) return 0;
  let n = 0;
  for (const id of log.order) {
    const it = log.byId[id];
    if (it && editPath(it) === path) n++;
  }
  return n;
}

/**
 * Calls `onEdit` when the selected thread finishes another Edit, MultiEdit, Write or
 * NotebookEdit of `path` (absolute, as Claude passes it). Only the visible thread's log is
 * loaded, which is the one whose panel shows the tab.
 */
export function useToolEdits(path: string, onEdit: () => void): void {
  const threadId = useUiStore((s) => (s.selection.kind === "thread" ? s.selection.id : ""));
  const count = useThreadStore((s) => (threadId ? editsOf(s.logs[threadId], path) : 0));
  const seen = useRef(count);
  const fire = useEffectEvent(onEdit);
  useEffect(() => {
    const before = seen.current;
    seen.current = count;
    if (count > before) fire();
  }, [count]);
}

/**
 * Calls `onChange` when the file at `path` (absolute) is written, by anything: the thread's
 * own tools, its Bash (`cp` over it, `touch`), another process (stores/fileStamps.ts). The
 * visible thread's finished Edit, MultiEdit, Write or NotebookEdit of it reads its stamp at
 * once rather than at the next poll, so that edit shows without the wait and still loads
 * once. With `gone`, also when the file goes away. An empty path watches nothing.
 */
export function useFileChanges(path: string, onChange: () => void, opts: WatchOptions = {}): void {
  const fire = useEffectEvent(onChange);
  const gone = opts.gone === true;
  useEffect(() => {
    if (!path) return;
    return fileWatcher.watch(
      path,
      () => {
        fire();
      },
      { gone },
    );
  }, [path, gone]);
  useToolEdits(path, () => {
    fileWatcher.check(path);
  });
}
