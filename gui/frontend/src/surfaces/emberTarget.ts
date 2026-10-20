/**
 * The Board surface's targets (surfaces/ember.ts): whether a selection is Ember's chat, and
 * the tab. Pure: callers feed it the stores' current state.
 */
import type { ThreadsData } from "@/stores/threads";
import { makeTab, type Tab } from "@/stores/panel";
import type { Selection } from "@/stores/ui";

export const EMBER_KIND = "ember";
export const EMBER_TITLE = "Board";
/** The view selection that shows Ember's chat by role (App.tsx): its thread, or "waking up" while it has none. */
export const EMBER_VIEW = "ember";
const RESIDENT = "ember";

/** Whether the selection shows Ember's chat (its thread, or the Ember view) while Ember is on. */
export function selectionIsEmber(sel: Selection, threads: ThreadsData, enabled: boolean): boolean {
  if (!enabled) return false;
  if (sel.kind === "view") return sel.name === EMBER_VIEW;
  return sel.kind === "thread" && threads.byId[sel.id]?.resident === RESIDENT;
}

/** The surface's one tab per panel: no params (the board is Ember's, whichever chat shows it). */
export function emberBoardTab(): Tab {
  return makeTab(EMBER_KIND, EMBER_TITLE);
}
