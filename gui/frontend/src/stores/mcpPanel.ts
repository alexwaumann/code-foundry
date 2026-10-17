/**
 * Opening the MCP surface (surfaces/mcp.ts). The view.panel.mcp command (mcpPanelCommand
 * in stores/views.ts) ends here.
 */
import { mcpTab, selectionMcpThread } from "@/surfaces/mcpTarget";
import { keyOf, openSurface } from "./panel";
import { useReposStore } from "./repos";
import { useThreadsStore } from "./threads";
import { useUiStore, type Selection } from "./ui";

/**
 * Opens (or activates) the MCP tab in the selection's panel when the selection is a
 * thread. Returns that panel's key, or null otherwise. It does not request focus.
 */
export function openMcpSurface(sel: Selection = useUiStore.getState().selection): string | null {
  const key = keyOf(sel);
  const s = { repos: useReposStore.getState(), threads: useThreadsStore.getState() };
  if (key === null || selectionMcpThread(sel, s) === null) return null;
  return openSurface(key, mcpTab()) ? key : null;
}
