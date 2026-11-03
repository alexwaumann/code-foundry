import { useEffect, useRef, useState } from "react";
import { invalidateOnTransportError } from "@/api/endpoint";
import { isSearchGone, watchRecentSearches, watchSearch, type SearchEntryView, type SearchWatchEventView } from "@/api/search";
import { runStream, type Heartbeat } from "@/api/stream";
import { reduceSearch, searchEnded } from "@/lib/agentSearch";

/** Opens one Watch attempt (a test passes a fake). */
export type WatchSearchFn = (id: string, signal: AbortSignal) => AsyncIterable<SearchWatchEventView | Heartbeat>;
/** Opens one WatchRecent attempt (a test passes a fake). */
export type WatchRecentFn = (signal: AbortSignal) => AsyncIterable<SearchEntryView[] | Heartbeat>;

/** The shown search: the entry as Watch has it, and whether it was forgotten (NOT_FOUND). */
export interface WatchedSearch {
  entry: SearchEntryView | null;
  gone: boolean;
}

/**
 * The agent search `id` while the dialog shows it: SearchService.Watch's snapshot and
 * events folded into the entry (lib/agentSearch reduceSearch). `seed` (the entry
 * StartAgent or Recent searches gave) shows until the snapshot. The stream ends after the
 * status; it reconnects only while the search runs (a reconnect starts from a snapshot).
 * One stream while shown: closing the dialog closes it, and the run goes on.
 */
export function useSearchWatch(id: string | null, seed: SearchEntryView | null, watch: WatchSearchFn = watchSearch): WatchedSearch {
  const [state, setState] = useState<{ id: string | null; entry: SearchEntryView | null; gone: boolean }>({ id, entry: seed?.id === id ? seed : null, gone: false });
  // The entry as last folded, for the stream's end rule (read outside render only).
  const latest = useRef(state.entry);
  if (state.id !== id) {
    // A new search shown: its seed until its snapshot.
    setState({ id, entry: seed?.id === id ? seed : null, gone: false });
  }
  useEffect(() => {
    if (!id) return;
    latest.current = null;
    return runStream<SearchWatchEventView>({
      open: (signal) => watch(id, signal),
      slot: { label: "search:watch", priority: "core" },
      onEvent: (ev) => {
        setState((s) => {
          if (s.id !== id) return s;
          const entry = reduceSearch(s.entry, ev);
          latest.current = entry;
          return entry === s.entry ? s : { ...s, entry };
        });
      },
      // Ended after the status (or a finished entry's snapshot): nothing more will come.
      shouldReconnectOnEnd: () => !(latest.current && searchEnded(latest.current)),
      onError: (err) => {
        if (isSearchGone(err)) {
          setState((s) => (s.id === id ? { ...s, gone: true } : s));
          return;
        }
        invalidateOnTransportError(err);
      },
    });
  }, [id, watch]);
  return state.id === id ? { entry: state.entry, gone: state.gone } : { entry: seed?.id === id ? seed : null, gone: false };
}

/**
 * The search history while Recent searches shows (SearchService.WatchRecent: the list now
 * and after every change); null until the first list. Not held while `on` is false.
 */
export function useRecentSearches(on: boolean, watch: WatchRecentFn = watchRecentSearches): SearchEntryView[] | null {
  const [list, setList] = useState<SearchEntryView[] | null>(null);
  useEffect(() => {
    if (!on) return;
    return runStream<SearchEntryView[]>({
      open: (signal) => watch(signal),
      slot: { label: "search:recent", priority: "inline" },
      onEvent: setList,
      onError: invalidateOnTransportError,
    });
  }, [on, watch]);
  return list;
}
