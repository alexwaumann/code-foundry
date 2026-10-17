/**
 * Files and directories the composer offers after "@" (FilesystemService.SearchFiles),
 * per source list (lib/completion fileSourcesKey: the draft's projects and the checkouts
 * to search). The composer asks with `requestFiles` on every change of the query:
 *
 * - debounced (DEBOUNCE_MS), so a burst of keystrokes sends one search, one request per
 *   member (FILE_LIMIT matches each), fanned out at once;
 * - a request sequence per list: an answer lands only when no later request's answer has
 *   (stale answers are ignored, not aborted: the daemon lists in the background anyway);
 * - `searching` turns on when the latest request has been out longer than
 *   SEARCHING_AFTER_MS;
 * - the last answer stays cached, so asking again for the answered query within FRESH_MS
 *   (the daemon's own cache) sends nothing, and after that shows it while it refreshes;
 * - a daemon older than the RPC marks the entry outdated; nothing is asked again and the
 *   composer offers no card.
 *
 * A member whose search fails otherwise answers with no matches.
 */
import { create } from "zustand";
import { searchFiles, type FileSearchRequest, type FileSearchView, type SkillSourceView } from "@/api/filesystem";
import { isOutdatedDaemon } from "@/api/errors";
import { fileSourcesKey, type FileResults } from "@/lib/completion";

export const DEBOUNCE_MS = 80;
export const SEARCHING_AFTER_MS = 300;
export const FRESH_MS = 5000;
export const FILE_LIMIT = 30;

export interface FilesEntry {
  /** The query `results` answer (null: nothing answered yet). */
  answered: string | null;
  /** Per member, in source order. */
  results: readonly FileResults[];
  /** The latest request has been out longer than SEARCHING_AFTER_MS. */
  searching: boolean;
  /** The daemon predates SearchFiles. */
  outdated: boolean;
}

interface FilesState {
  byKey: Readonly<Record<string, FilesEntry>>;
}

export const useFilesStore = create<FilesState>()(() => ({ byKey: {} }));

/** SearchFiles, replaceable in tests. */
export type SearchFilesFn = (req: FileSearchRequest) => Promise<FileSearchView>;

/** Per list: timers and the request bookkeeping (not state anything renders). */
interface Control {
  /** The debounce timer of the query asked last. */
  debounce: ReturnType<typeof setTimeout> | undefined;
  /** The "searching" timer of the latest request. */
  slow: ReturnType<typeof setTimeout> | undefined;
  /** The latest request's number and query. */
  seq: number;
  latest: string | null;
  /** The number of the request whose answer landed last. */
  applied: number;
  /** When it landed (ms). */
  appliedAt: number;
}

const controls = new Map<string, Control>();

function control(key: string): Control {
  let c = controls.get(key);
  if (!c) {
    c = { debounce: undefined, slow: undefined, seq: 0, latest: null, applied: 0, appliedAt: 0 };
    controls.set(key, c);
  }
  return c;
}

const EMPTY: FilesEntry = { answered: null, results: [], searching: false, outdated: false };

function patch(key: string, change: Partial<FilesEntry>): void {
  useFilesStore.setState((s) => ({ byKey: { ...s.byKey, [key]: { ...(s.byKey[key] ?? EMPTY), ...change } } }));
}

function send(key: string, sources: readonly SkillSourceView[], query: string, search: SearchFilesFn): void {
  const c = control(key);
  c.debounce = undefined;
  const seq = ++c.seq;
  c.latest = query;
  clearTimeout(c.slow);
  c.slow = setTimeout(() => {
    if (c.seq === seq && c.applied < seq) patch(key, { searching: true });
  }, SEARCHING_AFTER_MS);
  const asks = sources.map((s) => search({ projectId: s.projectId, ...(s.path ? { path: s.path } : {}), query, limit: FILE_LIMIT }));
  void Promise.allSettled(asks).then((settled) => {
    if (seq <= c.applied) return; // a later request's answer landed first
    c.applied = seq;
    c.appliedAt = Date.now();
    const done = seq === c.seq;
    if (done) clearTimeout(c.slow);
    if (settled.some((r) => r.status === "rejected" && isOutdatedDaemon(r.reason))) {
      clearTimeout(c.debounce);
      clearTimeout(c.slow);
      patch(key, { answered: null, results: [], searching: false, outdated: true });
      return;
    }
    const results = settled.map((r, i) => ({ projectId: sources[i]?.projectId ?? "", matches: r.status === "fulfilled" ? r.value.matches : [] }));
    patch(key, { answered: query, results, ...(done ? { searching: false } : {}) });
  });
}

/**
 * Asks for the files matching a query in a source list (debounced; see the header). Asking
 * for the answered query while it is fresh, or for the query already on its way, sends
 * nothing.
 */
export function requestFiles(sources: readonly SkillSourceView[], query: string, search: SearchFilesFn = searchFiles): void {
  const key = fileSourcesKey(sources);
  if (useFilesStore.getState().byKey[key]?.outdated) return;
  const c = control(key);
  clearTimeout(c.debounce);
  c.debounce = undefined;
  const entry = useFilesStore.getState().byKey[key];
  if (entry?.answered === query && Date.now() - c.appliedAt < FRESH_MS) {
    // Back to the answered query (Backspace) while another is out: that answer must not
    // replace this one when it lands.
    if (c.applied < c.seq) {
      c.applied = c.seq;
      clearTimeout(c.slow);
      if (entry.searching) patch(key, { searching: false });
    }
    return;
  }
  if (c.latest === query && c.applied < c.seq) return; // already on its way
  c.debounce = setTimeout(() => {
    send(key, sources, query, search);
  }, DEBOUNCE_MS);
}

/** Drops a search still waiting out its debounce (the trigger closed). Requests out stay out. */
export function cancelFiles(sources: readonly SkillSourceView[]): void {
  const c = controls.get(fileSourcesKey(sources));
  if (!c) return;
  clearTimeout(c.debounce);
  c.debounce = undefined;
}

/** The entry of a source list (undefined before its first request). */
export function useFilesEntry(key: string): FilesEntry | undefined {
  return useFilesStore((s) => s.byKey[key]);
}

/** Test helper: forgets everything. */
export function resetFiles(): void {
  for (const c of controls.values()) {
    clearTimeout(c.debounce);
    clearTimeout(c.slow);
  }
  controls.clear();
  useFilesStore.setState({ byKey: {} });
}
