/**
 * Opening the MCP surface (surfaces/mcp.ts) from the window: the thread info card's MCP row.
 * The daemon's view.open.mcp opens the same tab in the layout itself.
 */
import { mcpTab, selectionMcpThread } from "@/surfaces/mcpTarget";
import { openTab, targetOf } from "@/shell/host";
import { useThreadsStore } from "./threads";
import { useUiStore, type Selection } from "./ui";

/**
 * Opens (or activates) the MCP tab in the selection's panel when the selection is a
 * thread, with the focus unless `focus: false`. Returns that panel's key, or null otherwise.
 */
export function openMcpSurface(sel: Selection = useUiStore.getState().selection, opts: { focus?: boolean } = {}): string | null {
  const key = targetOf(sel);
  if (key === null || selectionMcpThread(sel, { threads: useThreadsStore.getState() }) === null) return null;
  return openTab(key, mcpTab(), opts) ? key : null;
}
