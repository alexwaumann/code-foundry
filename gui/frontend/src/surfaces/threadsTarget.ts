/**
 * The Threads surface's targets: which thread a selection resolves to (availability) and
 * the tab. Pure: callers feed it the stores' current state.
 */
import { hasLineage } from "@/lib/lineage";
import { makeTab, type Tab } from "@/stores/panel";
import type { Selection } from "@/stores/ui";
import { selectionThread, type SelectionStores } from "./linkedprsTarget";

export const THREADS_KIND = "threads";
export const THREADS_TITLE = "Threads";

/**
 * The selection's thread when it has lineage (lib/lineage hasLineage: a creator, siblings
 * or children): the surface is enabled. Null otherwise, for a thread without any too
 * (the surface is hidden then), a page or a composer.
 */
export function selectionThreadsThread(sel: Selection, s: SelectionStores): string | null {
  const id = selectionThread(sel, s);
  return id !== null && hasLineage(s.threads, id) ? id : null;
}

/** The surface's one tab per panel: no params (it follows the selection's thread). */
export function threadsTab(): Tab {
  return makeTab(THREADS_KIND, THREADS_TITLE);
}
