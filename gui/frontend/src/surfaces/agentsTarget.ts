/**
 * The Agents surface's targets: which thread a selection resolves to (availability) and
 * the tab. Pure: callers feed it the stores' current state.
 */
import { makeTab, type Tab } from "@/stores/panel";
import type { Selection } from "@/stores/ui";
import { selectionThread, type SelectionStores } from "./linkedprsTarget";

export const AGENTS_KIND = "agents";
export const AGENTS_TITLE = "Agents";

/**
 * The selection's thread when the sessions store knows it (selectionThread). Null
 * otherwise, a page or a composer included. Whether Claude runs for it does not matter: its runs persist.
 */
export function selectionAgentsThread(sel: Selection, s: SelectionStores): string | null {
  return selectionThread(sel, s);
}

/** The surface's one tab per panel: no params (it follows the selection's thread). */
export function agentsTab(): Tab {
  return makeTab(AGENTS_KIND, AGENTS_TITLE);
}
