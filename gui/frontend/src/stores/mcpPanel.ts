/**
 * Opening the MCP surface (surfaces/mcp.ts). The view.panel.mcp command (mcpPanelCommand
 * in stores/views.ts) ends here.
 */
import { mcpTab, selectionMcpThread } from "@/surfaces/mcpTarget";
import { openTab, targetOf } from "@/shell/host";
import { useThreadsStore } from "./threads";
import { useUiStore, type Selection } from "./ui";

/**
 * Opens (or activates) the MCP tab in the selection's panel when the selection is a
 * thread. Returns that panel's key, or null otherwise. It does not request focus.
 */
export function openMcpSurface(sel: Selection = useUiStore.getState().selection): string | null {
  const key = targetOf(sel);
  if (key === null || selectionMcpThread(sel, { threads: useThreadsStore.getState() }) === null) return null;
  return openTab(key, mcpTab()) ? key : null;
}
