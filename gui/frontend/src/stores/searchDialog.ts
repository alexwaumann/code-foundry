/**
 * The search dialog's memory (docs/notes/search-6-agent-gui.md): the last mode used
 * (persisted, localStorage "code-foundry.searchDialog": it survives app restarts; Agent
 * search before the first use) and the last open's session, which the dialog restores when
 * it opens again within RESTORE_MS (lib/agentSearch). The session lives in memory only.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { SEARCH_MODE_IDS, sessionToRestore, type SearchModeId, type SearchSession } from "@/lib/agentSearch";
import { oneOf, persistedRecord } from "./persisted";

interface SearchDialogState {
  mode: SearchModeId;
  session: SearchSession | null;
}

export const useSearchDialogStore = create<SearchDialogState>()(
  persist((): SearchDialogState => ({ mode: "agent", session: null }), {
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

/** Forgets the session (its search was forgotten, or the history cleared). */
export function dropSearchSession(entryId?: string): void {
  useSearchDialogStore.setState((s) => (s.session && (entryId === undefined || s.session.entryId === entryId) ? { session: null } : s));
}
