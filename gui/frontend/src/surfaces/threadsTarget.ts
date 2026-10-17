/**
 * The Threads surface's targets: which thread a selection resolves to (availability) and
 * the tab. Pure: callers feed it the stores' current state.
 */
import { makeTab, type Tab } from "@/stores/panel";
import type { Selection } from "@/stores/ui";
import { selectionThread, type SelectionStores } from "./linkedprsTarget";

export const THREADS_KIND = "threads";
export const THREADS_TITLE = "Threads";

/**
 * The selection's thread when the threads store knows it (selectionThread), with or
 * without lineage: the surface says when no thread was created from here. Null for a
 * page or a composer.
 */
export function selectionThreadsThread(sel: Selection, s: SelectionStores): string | null {
  return selectionThread(sel, s);
}

/** The surface's one tab per panel: no params (it follows the selection's thread). */
export function threadsTab(): Tab {
  return makeTab(THREADS_KIND, THREADS_TITLE);
}
