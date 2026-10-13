/**
 * The MCP surface's targets: which thread a selection resolves to (availability) and the
 * tab. Pure: callers feed it the stores' current state.
 */
import { makeTab, type Tab } from "@/stores/panel";
import type { Selection } from "@/stores/ui";
import { selectionThread, type SelectionStores } from "./linkedprsTarget";

export const MCP_KIND = "mcp";
export const MCP_TITLE = "MCP";

/**
 * The selection's thread when the sessions store knows it (selectionThread). Null
 * otherwise, a page or a composer included. A disconnected thread counts: the surface
 * says it has no servers to show until it reconnects.
 */
export function selectionMcpThread(sel: Selection, s: SelectionStores): string | null {
  return selectionThread(sel, s);
}

/** The surface's one tab per panel: no params (it follows the selection's thread). */
export function mcpTab(): Tab {
  return makeTab(MCP_KIND, MCP_TITLE);
}
