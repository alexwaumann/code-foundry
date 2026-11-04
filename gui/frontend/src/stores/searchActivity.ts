/**
 * What the app knows of agent searches outside the dialog, for the sidebar's search row
 * (docs/notes/search-sidebar-row.md). EventService's search source sends it whole, on
 * connect and per change, so every event replaces it: a snapshot after a reconnect or a
 * daemon restart leaves nothing of the old state, a lost run's "running" included.
 */
import { create } from "zustand";
import type { SearchActivityView } from "@/api/search";

interface SearchActivityState {
  /** Null until the first event. */
  activity: SearchActivityView | null;
}

export const useSearchActivityStore = create<SearchActivityState>()(() => ({ activity: null }));

/** The search event source's handler (stores/events.ts). */
export function applySearchActivity(activity: SearchActivityView): void {
  useSearchActivityStore.setState({ activity });
}
