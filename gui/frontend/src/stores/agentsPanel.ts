/**
 * Opening the Agents surface (surfaces/agents.ts). The view.panel.agents command
 * (agentsPanelCommand in stores/views.ts) ends here.
 */
import { agentsTab, selectionAgentsThread } from "@/surfaces/agentsTarget";
import { keyOf, openSurface } from "./panel";
import { useProjectsStore } from "./projects";
import { useThreadsStore } from "./threads";
import { useUiStore, type Selection } from "./ui";

/**
 * Opens (or activates) the Agents tab in the selection's panel when the selection is a
 * thread. Returns that panel's key, or null otherwise. It does not request focus.
 */
export function openAgentsSurface(sel: Selection = useUiStore.getState().selection): string | null {
  const key = keyOf(sel);
  const s = { repos: useProjectsStore.getState(), threads: useThreadsStore.getState() };
  if (key === null || selectionAgentsThread(sel, s) === null) return null;
  return openSurface(key, agentsTab()) ? key : null;
}
