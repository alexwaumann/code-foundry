/**
 * Opening the workspace surface (surfaces/workspace.ts) and its member tabs. The
 * view.panel.workspace command (workspacePanelCommand in stores/views.ts), the sidebar's
 * workspace badge, the session header button (the command) and the Projects page's
 * workspace rows all end here.
 */
import { memberTab, selectionWorkspaceThread, workspaceTab } from "@/surfaces/workspaceTarget";
import { keyOf, openSurface, togglePanel, type PanelTarget } from "./panel";
import { useReposStore } from "./repos";
import { useSessionsStore } from "./sessions";
import { useTerminalsStore } from "./terminals";
import { useUiStore, type Selection } from "./ui";
import { useWorkspacesStore } from "./workspaces";

/**
 * Opens (or activates) the workspace tab in the selection's panel when the selection is a
 * workspace thread (or its terminal). Returns that panel's key, or null when the
 * selection is no workspace thread. It does not request focus.
 */
export function openWorkspaceSurface(sel: Selection = useUiStore.getState().selection): string | null {
  const key = keyOf(sel);
  const thread = selectionWorkspaceThread(sel, { repos: useReposStore.getState(), sessions: useSessionsStore.getState(), terminals: useTerminalsStore.getState() });
  if (key === null || thread === null) return null;
  const name = useWorkspacesStore.getState().byId[thread.workspaceId]?.name ?? "";
  return openSurface(key, workspaceTab(thread.workspaceId, name)) ? key : null;
}

/**
 * The Projects page's "Show in thread": selects the workspace thread and opens the
 * workspace surface in its panel, which takes focus.
 */
export function showWorkspaceInThread(sessionId: string): boolean {
  const sel: Selection = { kind: "session", id: sessionId };
  useUiStore.getState().select(sel);
  const key = openWorkspaceSurface(sel);
  if (key === null) return false;
  togglePanel(key, true, { focus: true });
  return true;
}

/** Opens a workspace member's worktree as a tab of the panel (the worktree overview, panel variant). */
export function openMemberTab(target: PanelTarget, repoId: string, path: string): boolean {
  const name = useReposStore.getState().byId[repoId]?.name ?? repoId;
  return openSurface(target, memberTab(repoId, path, name));
}
