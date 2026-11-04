/**
 * The search dialog's memory (docs/notes/search-6-agent-gui.md): the last mode used
 * (persisted, localStorage "code-foundry.searchDialog": it survives app restarts; Agent
 * search before the first use) and the last open's session, which the dialog restores when
 * it opens again within RESTORE_MS (lib/agentSearch). The session lives in memory only, as
 * does the start in flight: a dialog closed before StartAgent answered still gets its
 * search (the saved session takes the entry's id), and one reopened meanwhile waits for it.
 * The target is the search the next open shows (search.open with an id: the sidebar's row).
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { SearchEntryView } from "@/api/search";
import { SEARCH_MODE_IDS, sessionToRestore, type SearchModeId, type SearchSession } from "@/lib/agentSearch";
import { oneOf, persistedRecord } from "./persisted";

interface SearchDialogState {
  mode: SearchModeId;
  session: SearchSession | null;
  /** The agent search being started (StartAgent not answered yet), by its question. */
  pending: { query: string; result: Promise<SearchEntryView> } | null;
  /** The search the next open shows, until the dialog has taken it. */
  target: SearchEntryView | null;
  /** Counts targets: the palette keys the dialog on it, so an open dialog goes to a new one. */
  targetSeq: number;
}

export const useSearchDialogStore = create<SearchDialogState>()(
  persist((): SearchDialogState => ({ mode: "agent", session: null, pending: null, target: null, targetSeq: 0 }), {
    name: "code-foundry.searchDialog",
    version: 1,
    partialize: (s) => ({ mode: s.mode }),
    merge: (persisted, current) => ({ ...current, mode: oneOf(persistedRecord(persisted).mode, SEARCH_MODE_IDS, current.mode) }),
  }),
);

/** The mode the dialog opens in (a restore aside): the last one used. */
export function lastSearchMode(): SearchModeId {
  return useSearchDialogStore.getState().mode;
}

export function setSearchMode(mode: SearchModeId): void {
  if (useSearchDialogStore.getState().mode !== mode) useSearchDialogStore.setState({ mode });
}

/** The dialog closed: what it showed, for a reopen within RESTORE_MS. */
export function saveSearchSession(s: SearchSession): void {
  useSearchDialogStore.setState({ session: s, mode: s.mode });
}

/** The session to restore at `now` (null after RESTORE_MS, or none kept). */
export function searchSessionAt(now: number): SearchSession | null {
  return sessionToRestore(useSearchDialogStore.getState().session, now);
}

/** The next open shows `e`, whatever a saved session says. */
export function setSearchTarget(e: SearchEntryView): void {
  useSearchDialogStore.setState((s) => ({ target: e, targetSeq: s.targetSeq + 1 }));
}

/** The search this open was asked to show; null for none. */
export function searchTarget(): SearchEntryView | null {
  return useSearchDialogStore.getState().target;
}

/** The dialog has what it was asked to show. */
export function clearSearchTarget(): void {
  if (useSearchDialogStore.getState().target) useSearchDialogStore.setState({ target: null });
}

/** Forgets the session (its search was forgotten, or the history cleared). */
export function dropSearchSession(entryId?: string): void {
  useSearchDialogStore.setState((s) => (s.session && (entryId === undefined || s.session.entryId === entryId) ? { session: null } : s));
}

/**
 * An agent search is starting for `query` (trimmed). When it starts, a session saved with
 * that question and no search shown (the dialog closed while it started) takes its id, so
 * a reopen within RESTORE_MS shows it rather than asking again.
 */
export function trackSearchStart(query: string, result: Promise<SearchEntryView>): void {
  useSearchDialogStore.setState({ pending: { query, result } });
  const settle = (e: SearchEntryView | null) => {
    useSearchDialogStore.setState((s) => ({
      pending: s.pending?.result === result ? null : s.pending,
      session: e && s.session && s.session.entryId === null && s.session.query.trim() === query ? { ...s.session, entryId: e.id } : s.session,
    }));
  };
  result.then(settle, () => {
    settle(null);
  });
}

/** The start in flight for `query` (trimmed), for a dialog reopened before it answered; null for none. */
export function pendingSearchStart(query: string): Promise<SearchEntryView> | null {
  const p = useSearchDialogStore.getState().pending;
  return p && p.query === query ? p.result : null;
}
