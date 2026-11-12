/**
 * The MCP surface's targets: which thread a selection resolves to (whether it opens) and
 * the tab. Pure: callers feed it the threads store's current state.
 */
import { makeTab, type Tab } from "@/shell/host";
import type { ThreadsData } from "@/stores/threads";
import type { Selection } from "@/stores/ui";

export const MCP_KIND = "mcp";
export const MCP_TITLE = "MCP";

/**
 * The selection's thread when the threads store knows it. Null otherwise, a page or a
 * composer included. Whether Claude runs for it does not matter: the last status outlives
 * the process, and Refresh starts Claude.
 */
export function selectionMcpThread(sel: Selection, s: { threads: ThreadsData }): string | null {
  return sel.kind === "thread" && s.threads.byId[sel.id] ? sel.id : null;
}

/** The surface's one tab per panel: no params (it follows the selection's thread). */
export function mcpTab(): Tab {
  return makeTab(MCP_KIND, MCP_TITLE);
}
