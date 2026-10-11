/**
 * The Usage surface's targets: which thread a selection resolves to (availability) and the
 * tab. Pure: callers feed it the stores' current state.
 */
import { makeTab, type Tab } from "@/stores/panel";
import type { Selection } from "@/stores/ui";
import { selectionThread, type SelectionStores } from "./linkedprsTarget";

export const USAGE_KIND = "usage";
export const USAGE_TITLE = "Usage";

/**
 * The selection's thread for the Usage surface: a session, or a thread's terminal, that
 * the sessions store knows (the same resolution as Linked PRs, which is what
 * view.panel.usage's availability sees). A thread without usage still counts: the surface
 * says "No usage yet". Null for a plain terminal, a worktree, a page or a composer.
 */
export function selectionUsageThread(sel: Selection, s: SelectionStores): string | null {
  return selectionThread(sel, s);
}

/** The surface's one tab per panel: no params (it follows the selection's thread). */
export function usageTab(): Tab {
  return makeTab(USAGE_KIND, USAGE_TITLE);
}
