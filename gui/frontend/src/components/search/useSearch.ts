import { useEffect, useRef, useState } from "react";
import { errorMessage, isAbort } from "@/api/stream";
import type { ThreadItemView } from "@/api/thread";
import { readHitItem, readLastReply, readPromptBefore, searchThreads, type PromptCache, type SearchResultView } from "@/api/threadSearch";

/** How long typing pauses before the dialog searches. */
export const SEARCH_DEBOUNCE_MS = 90;
/** How long the selection rests on a row before its preview loads (holding an arrow key loads nothing in between). */
export const PREVIEW_DEBOUNCE_MS = 40;

export type SearchFn = (query: string, signal: AbortSignal) => Promise<SearchResultView>;

const defaultSearch: SearchFn = (query, signal) => searchThreads(query, { signal });

/** The search for a query: the last answer (kept while the next one is out) and which query it answered. */
export interface SearchState {
  /** The query `result` (or `error`) answers; "" before the first. */
  answered: string;
  result: SearchResultView | null;
  error: string | null;
}

const NOTHING: SearchState = { answered: "", result: null, error: null };

/**
 * Searches as the user types: after a short pause, the newest query only (an older
 * request is aborted, and an answer that arrives late is dropped). The previous answer
 * stays on screen until the new one arrives, so the list does not blink empty.
 */
export function useThreadSearch(query: string, search: SearchFn = defaultSearch): SearchState {
  const [state, setState] = useState<SearchState>(NOTHING);
  useEffect(() => {
    if (query === "") return;
    const ctl = new AbortController();
    const timer = setTimeout(() => {
      search(query, ctl.signal).then(
        (result) => {
          if (!ctl.signal.aborted) setState({ answered: query, result, error: null });
        },
        (err: unknown) => {
          if (ctl.signal.aborted || isAbort(err)) return;
          setState({ answered: query, result: null, error: errorMessage(err) });
        },
      );
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [query, search]);
  // No query: nothing, whatever an earlier query left (the next one replaces it).
  return query === "" ? NOTHING : state;
}

/** What the preview shows for a row: a message hit, or a thread whose name matched. */
export type PreviewTarget = { kind: "hit"; threadId: string; itemId: string; ordinal: number; withPrompt: boolean } | { kind: "thread"; threadId: string };

/** The preview's data: the message (a hit's item, or the thread's latest text from Claude) and the prompt before it. */
export interface PreviewData {
  key: string;
  item: ThreadItemView | null;
  prompt: ThreadItemView | null;
  error: string | null;
}

/** Where the preview reads from (the daemon's ListItems; tests pass fakes). */
export interface PreviewLoaders {
  hitItem: (threadId: string, itemId: string, ordinal: number) => Promise<ThreadItemView | null>;
  promptBefore: (threadId: string, ordinal: number) => Promise<ThreadItemView | null>;
  lastReply: (threadId: string) => Promise<ThreadItemView | null>;
}

/** The daemon's reads, with one cache of threads' user messages for as long as the dialog is open. */
function daemonLoaders(): PreviewLoaders {
  const prompts: PromptCache = new Map();
  return {
    hitItem: (threadId, itemId, ordinal) => readHitItem(threadId, itemId, ordinal),
    promptBefore: (threadId, ordinal) => readPromptBefore(threadId, ordinal, prompts),
    lastReply: (threadId) => readLastReply(threadId),
  };
}

export function previewKey(t: PreviewTarget): string {
  return t.kind === "hit" ? `hit:${t.threadId}:${t.itemId}` : `thread:${t.threadId}`;
}

async function loadPreview(t: PreviewTarget, l: PreviewLoaders): Promise<Omit<PreviewData, "key" | "error">> {
  if (t.kind === "thread") return { item: await l.lastReply(t.threadId), prompt: null };
  const [item, prompt] = await Promise.all([l.hitItem(t.threadId, t.itemId, t.ordinal), t.withPrompt ? l.promptBefore(t.threadId, t.ordinal) : Promise.resolve(null)]);
  return { item, prompt };
}

/**
 * The selected row's preview data, read once per row while the dialog is open (a row
 * visited again shows at once). Moving on drops an answer for the row left behind. Until
 * the row's data arrives the previous row's stays (`key` says whose it is).
 */
export function useSearchPreview(target: PreviewTarget | null, given?: PreviewLoaders): PreviewData | null {
  const [own] = useState(daemonLoaders);
  const loaders = given ?? own;
  const cache = useRef(new Map<string, PreviewData>());
  const [data, setData] = useState<PreviewData | null>(null);
  const key = target ? previewKey(target) : "";
  useEffect(() => {
    if (!target) return;
    const hit = cache.current.get(key);
    if (hit) {
      setData(hit);
      return;
    }
    let live = true;
    const timer = setTimeout(() => {
      loadPreview(target, loaders).then(
        (d) => {
          const v = { key, ...d, error: null };
          cache.current.set(key, v);
          if (live) setData(v);
        },
        (err: unknown) => {
          if (live) setData({ key, item: null, prompt: null, error: errorMessage(err) });
        },
      );
    }, PREVIEW_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
    // The target by key: a new answer naming the same row does not read it again.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [key, loaders]);
  return data;
}
