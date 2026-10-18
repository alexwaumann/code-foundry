import { createElement } from "react";
import { Bot } from "lucide-react";
import { AgentsSurface } from "@/components/agents/AgentsSurface";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import { AGENTS_KIND, AGENTS_TITLE, agentsTab, selectionAgentsThread } from "./agentsTarget";
import type { SurfaceSpec } from "./types";

function thread(sel: Selection): string | null {
  return selectionAgentsThread(sel, { projects: useProjectsStore.getState(), threads: useThreadsStore.getState() });
}

/**
 * Agents: the selected thread's subagent runs as the daemon follows them, one flat row
 * each in spawn order with nested runs under their parent: status, type · model · effort ·
 * mode, the live activity or the report or the error, elapsed time, tool uses and tokens
 * (docs/sketches/agents-panel variant L1, docs/notes/agents-2-gui.md). Enabled for a
 * thread with runs (the thread list's agentRuns), hidden otherwise, so the empty list
 * offers it only when there is something to show (docs/notes/panel-polish.md); an open tab
 * stays. One tab per panel, no params: the body follows the selection's thread, like MCP.
 * Opened by A in the panel, by view.panel.agents and by the strip above the composer
 * (stores/agentsPanel.ts).
 */
export const agentsSurface: SurfaceSpec = {
  kind: AGENTS_KIND,
  title: AGENTS_TITLE,
  icon: Bot,
  hotkey: "a",
  available: (ctx) => (thread(ctx.selection) ? "enabled" : "hidden"),
  // The runs are the thread list's (agentRuns): a new first run lists the surface at once.
  watches: [useThreadsStore, useProjectsStore],
  render: () => createElement(AgentsSurface),
  openDefault: (ctx) => (thread(ctx.selection) ? agentsTab() : null),
};
