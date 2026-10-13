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
 * The selection's thread when it is a rendered thread the sessions store knows (a
 * terminal thread's Claude reports no MCP status to the daemon). Null otherwise, a page or
 * a composer included. A disconnected rendered thread counts: the surface says it has no
 * servers to show until it reconnects.
 */
export function selectionMcpThread(sel: Selection, s: SelectionStores): string | null {
  const id = selectionThread(sel, s);
  return id !== null && s.sessions.byId[id]?.render === "rendered" ? id : null;
}

/** The surface's one tab per panel: no params (it follows the selection's thread). */
export function mcpTab(): Tab {
  return makeTab(MCP_KIND, MCP_TITLE);
}
