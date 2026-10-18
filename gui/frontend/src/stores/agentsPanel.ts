/**
 * Opening the Agents surface (surfaces/agents.ts). The view.panel.agents command
 * (agentsPanelCommand in stores/views.ts) ends here.
 */
import { agentsTab, selectionAgentsThread } from "@/surfaces/agentsTarget";
import { selectionThread } from "@/surfaces/linkedprsTarget";
import { keyOf, openSurface } from "./panel";
import { useProjectsStore } from "./projects";
import { useThreadsStore } from "./threads";
import { useUiStore, type Selection } from "./ui";

function stores() {
  return { projects: useProjectsStore.getState(), threads: useThreadsStore.getState() };
}

/** What the selection is for the surface: a thread with subagent runs, one without, or no thread. */
export function agentsPanelTarget(sel: Selection = useUiStore.getState().selection): "agents" | "none" | "no-thread" {
  const s = stores();
  if (selectionAgentsThread(sel, s) !== null) return "agents";
  return selectionThread(sel, s) !== null ? "none" : "no-thread";
}

/**
 * Opens (or activates) the Agents tab in the selection's panel when the selection is a
 * thread with subagent runs (the surface is enabled). Returns that panel's key, or null
 * otherwise. It does not request focus.
 */
export function openAgentsSurface(sel: Selection = useUiStore.getState().selection): string | null {
  const key = keyOf(sel);
  if (key === null || selectionAgentsThread(sel, stores()) === null) return null;
  return openSurface(key, agentsTab()) ? key : null;
}
