import { createElement } from "react";
import { Plug } from "lucide-react";
import { McpSurface } from "@/components/mcp/McpSurface";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import { MCP_KIND, MCP_TITLE, mcpTab, selectionMcpThread } from "./mcpTarget";
import type { SurfaceSpec } from "./types";

function thread(sel: Selection): string | null {
  return selectionMcpThread(sel, { projects: useProjectsStore.getState(), threads: useThreadsStore.getState() });
}

/**
 * MCP: the selected thread's MCP servers as Claude last reported them (checked at
 * the start of every turn), one card each with status, error or login hint, tools with
 * their hints, and Reconnect (docs/sketches/mcp-panel variant B, docs/notes/mcp-panel.md).
 * Enabled for a thread, hidden otherwise. One tab per panel, no params: the body
 * follows the selection's thread, like Usage. Opened by M in the panel and by
 * view.panel.mcp (stores/mcpPanel.ts).
 */
export const mcpSurface: SurfaceSpec = {
  kind: MCP_KIND,
  title: MCP_TITLE,
  icon: Plug,
  hotkey: "m",
  available: (ctx) => (thread(ctx.selection) ? "enabled" : "hidden"),
  watches: [useThreadsStore, useProjectsStore],
  render: () => createElement(McpSurface),
  openDefault: (ctx) => (thread(ctx.selection) ? mcpTab() : null),
};
