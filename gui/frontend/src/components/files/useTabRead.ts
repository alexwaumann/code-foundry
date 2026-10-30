/**
 * Reads for the File and Diff tabs (docs/notes/file-viewer-3-tabs.md). The data lives in
 * the tab's component state, so only the visible tab holds it and unmounting frees it; no
 * cache beyond the tab. A tab mounts each time it becomes the active one (SidePanel keys
 * its body by tab), so switching back to it reads again. Besides that, a read runs again
 * on the refresh button, when the window becomes visible, when the daemon recomputes the
 * file's worktree (worktree_detail_updated, seen through the worktree detail resource),
 * and when the visible thread's Edit, MultiEdit, Write or NotebookEdit on the file
 * finishes. Event-driven reads are debounced.
 */
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { errorMessage, isAbort, onVisibilityChange } from "@/api/stream";
import type { ThreadItemView } from "@/api/thread";
import { parseObject } from "@/lib/toolSummary";
import { fileWatcher } from "@/stores/fileStamps";
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
}

/** How long event-driven re-reads wait for more events. */
export const REFRESH_DEBOUNCE_MS = 250;

/**
 * Runs `read` for `key` on mount, whenever the key changes (the previous read is
 * aborted), and on reload(). `read` may change identity freely: the latest one runs.
 */
export function useTabRead<T>(key: string, read: (signal: AbortSignal) => Promise<T>): TabRead<T> {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{ key: string; nonce: number; data: T | null; error: string | null }>({ key: "", nonce: -1, data: null, error: null });
  const run = useEffectEvent((signal: AbortSignal) => read(signal));
  useEffect(() => {
    const c = new AbortController();
    run(c.signal)
      .then((data) => {
        if (!c.signal.aborted) setState({ key, nonce, data, error: null });
      })
      .catch((err: unknown) => {
        if (c.signal.aborted || isAbort(err)) return;
        setState((s) => ({ key, nonce, data: s.key === key ? s.data : null, error: errorMessage(err) }));
      });
    return () => {
      c.abort();
    };
  }, [key, nonce]);
  const reload = useCallback(() => {
    setNonce((n) => n + 1);
  }, []);
  // Another key's answer is not this one's: until the new key answers there is nothing.
  const same = state.key === key;
  return { data: same ? state.data : null, error: same ? state.error : null, loading: !same || state.nonce !== nonce, reload };
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
 * once.
 */
export function useFileChanges(path: string, onChange: () => void): void {
  const fire = useEffectEvent(onChange);
  useEffect(
    () =>
      fileWatcher.watch(path, () => {
        fire();
      }),
    [path],
  );
  useToolEdits(path, () => {
    fileWatcher.check(path);
  });
}
