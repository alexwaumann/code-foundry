/**
 * The sidebar's search row, the part that is not a component
 * (docs/notes/search-sidebar-row.md): what it says for the daemon's activity.
 */
import type { SearchActivityView } from "@/api/search";

/** The row: the search a click opens, its words, and its state's look. */
export interface SearchRow {
  id: string;
  kind: "running" | "results" | "none" | "failed";
  label: string;
  /** The amber pill's number; 0 shows none. */
  count: number;
}

/**
 * The row for `a`: the unseen search that finished last, before one that runs; null for
 * neither. A failed run says so even with hits (the dialog shows them under the failure).
 */
export function searchRow(a: SearchActivityView | null): SearchRow | null {
  if (!a) return null;
  if (a.unseenId !== "") {
    if (a.unseenStatus === "failed") return { id: a.unseenId, kind: "failed", label: "Search failed", count: 0 };
    if (a.unseenHits === 0) return { id: a.unseenId, kind: "none", label: "No search results", count: 0 };
    return { id: a.unseenId, kind: "results", label: "Search results", count: a.unseenHits };
  }
  return a.runningId !== "" ? { id: a.runningId, kind: "running", label: "Searching…", count: 0 } : null;
}
