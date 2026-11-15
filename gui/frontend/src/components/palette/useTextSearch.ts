import { useEffect, useMemo, useState } from "react";
import { readFile, type FileReadView } from "@/api/files";
import type { FinderSourceView } from "@/api/filesystem";
import { errorMessage, isAbort } from "@/api/stream";
import { searchText, textSearchError, type TextFileView, type TextQueryView, type TextSearchError, type TextSummaryView } from "@/api/textSearch";
import { queryReady, searchKey, TEXT_DEBOUNCE_MS, TEXT_PREVIEW_DEBOUNCE_MS } from "@/lib/textSearch";

/** SearchText, replaceable in tests. */
export type SearchTextFn = typeof searchText;

/** A text search's state: the answer on screen and which search it answers. */
export interface TextSearchState {
  /** The search key (lib/textSearch searchKey) the files answer; null before the first answer. */
  answered: string | null;
  /** The query that search asked (the rows' paint and Enter's hand-off follow it, not the typed one). */
  query: TextQueryView | null;
  /** The files streamed so far, in order. */
  files: readonly TextFileView[];
  /** How it ended; null while the stream runs (or after an error). */
  summary: TextSummaryView | null;
  error: TextSearchError | null;
}

const NOTHING: TextSearchState = { answered: null, query: null, files: [], summary: null, error: null };

const SEP = "\u0001";

/** The checkouts as a key: a re-render with the same ones does not search again. */
export function sourcesKey(sources: readonly FinderSourceView[]): string {
  return sources.map((s) => s.projectId + SEP + s.path).join("\n");
}

/**
 * Searches the checkouts' text as the user types (FilesystemService.SearchText): after
 * TEXT_DEBOUNCE_MS, one stream at a time; a newer query, a toggle, the mode leaving
 * (`active` false) or the finder closing aborts the one out. The previous answer stays until
 * the new search's first message (its files, or a summary alone for no match), then the
 * files grow as messages arrive. A query shorter than TEXT_MIN_QUERY sends nothing and shows
 * nothing.
 */
export function useTextSearch(sources: readonly FinderSourceView[], q: TextQueryView, active: boolean, search: SearchTextFn = searchText): TextSearchState & { key: string; ready: boolean } {
  const [state, setState] = useState<TextSearchState>(NOTHING);
  const srcKey = sourcesKey(sources);
  const key = searchKey(q, srcKey);
  const ready = active && sources.length > 0 && queryReady(q.query);
  useEffect(() => {
    if (!ready) return;
    const ctl = new AbortController();
    let first = true;
    const timer = setTimeout(() => {
      search(
        { sources, ...q },
        (files) => {
          if (ctl.signal.aborted) return;
          if (first) {
            first = false;
            setState({ answered: key, query: q, files, summary: null, error: null });
          } else setState((s) => (s.answered === key ? { ...s, files: [...s.files, ...files] } : s));
        },
        ctl.signal,
      ).then(
        (summary) => {
          if (ctl.signal.aborted) return;
          if (first) setState({ answered: key, query: q, files: [], summary, error: null });
          else setState((s) => (s.answered === key ? { ...s, summary } : s));
        },
        (err: unknown) => {
          if (ctl.signal.aborted || isAbort(err)) return;
          const error = textSearchError(err);
          setState((s) => ({ answered: key, query: q, files: !first && s.answered === key ? s.files : [], summary: null, error }));
        },
      );
    }, TEXT_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // The search by key: the same query and checkouts in a new render do not search again.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [key, ready, search]);
  return useMemo(() => ({ ...(ready ? state : NOTHING), key, ready }), [ready, state, key]);
}

/** A file read for the preview: the read, or why it failed. */
export interface PreviewRead {
  /** lib/fileFinder absolutePath: the file's key. */
  fileKey: string;
  file: FileReadView | null;
  error: string | null;
}

/** ReadFile, replaceable in tests. */
export type ReadFileFn = (checkout: string, path: string, signal: AbortSignal) => Promise<FileReadView>;

const defaultRead: ReadFileFn = (checkout, path, signal) => readFile(checkout, path, undefined, signal);

/** How many files a finder keeps read (a file is up to 1 MiB of text). */
export const PREVIEW_CACHE_FILES = 24;

/** The finder's reads, kept for as long as it is open, the least recently shown dropped past PREVIEW_CACHE_FILES. */
export class PreviewCache {
  private readonly reads = new Map<string, PreviewRead>();
  get(key: string): PreviewRead | undefined {
    const r = this.reads.get(key);
    if (r) {
      this.reads.delete(key);
      this.reads.set(key, r);
    }
    return r;
  }
  set(key: string, r: PreviewRead): void {
    this.reads.delete(key);
    this.reads.set(key, r);
    while (this.reads.size > PREVIEW_CACHE_FILES) {
      const oldest = this.reads.keys().next().value;
      if (oldest === undefined) break;
      this.reads.delete(oldest);
    }
  }
}

/**
 * The selected match's file for the preview: read once the selection rests
 * TEXT_PREVIEW_DEBOUNCE_MS (holding an arrow key reads nothing in between), then kept in
 * `cache` for the finder's life, so a file visited again shows at once. Null until the
 * selected file's read is there (a failed read answers with its error, and is not kept).
 */
export function useTextPreview(target: { fileKey: string; checkout: string; path: string } | null, cache: PreviewCache, read: ReadFileFn = defaultRead): PreviewRead | null {
  const [data, setData] = useState<PreviewRead | null>(null);
  const key = target?.fileKey ?? "";
  useEffect(() => {
    if (!target) return;
    const hit = cache.get(key);
    if (hit) {
      setData(hit);
      return;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      read(target.checkout, target.path, ctl.signal).then(
        (file) => {
          const r = { fileKey: key, file, error: null };
          cache.set(key, r);
          if (!ctl.signal.aborted) setData(r);
        },
        (err: unknown) => {
          if (ctl.signal.aborted || isAbort(err)) return;
          setData({ fileKey: key, file: null, error: errorMessage(err) });
        },
      );
    }, TEXT_PREVIEW_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
    // The target by key: a new answer naming the same file does not read it again.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [key, cache, read]);
  return data && data.fileKey === key ? data : null;
}
