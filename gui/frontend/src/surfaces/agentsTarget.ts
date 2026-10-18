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
 * The selection's thread when it has subagent runs (the thread list's agentRuns; they
 * persist, so whether Claude runs for it does not matter): the surface is enabled. Null
 * otherwise, for a thread without runs too (the surface is hidden then), a page or a composer.
 */
export function selectionAgentsThread(sel: Selection, s: SelectionStores): string | null {
  const id = selectionThread(sel, s);
  return id !== null && (s.threads.byId[id]?.agentRuns.length ?? 0) > 0 ? id : null;
}

/** The surface's one tab per panel: no params (it follows the selection's thread). */
export function agentsTab(): Tab {
  return makeTab(AGENTS_KIND, AGENTS_TITLE);
}
