/**
 * "Add project" on a workspace from a menu (an index row's context menu, the workspace page's ⋯): the workspace's
 * page shows, with its Projects card's Add project list open (components/projects/WorkspaceProjects.tsx).
 * docs/notes/projects-table-2-context-menus.md.
 */
import { create } from "zustand";
import { useUiStore, workspacePage } from "./ui";

interface WorkspaceAddProjectState {
  /** The workspace whose Add project list is open from a menu, or null. */
  addingTo: string | null;
}

export const useWorkspaceAddProjectStore = create<WorkspaceAddProjectState>()(() => ({ addingTo: null }));

/** Shows the workspace's page (when it is not the selection) with its Add project list open. */
export function openWorkspaceAddProject(workspaceId: string): void {
  const ui = useUiStore.getState();
  const sel = ui.selection;
  if (!(sel.kind === "view" && sel.name === "projects" && sel.workspaceId === workspaceId)) ui.select(workspacePage(workspaceId));
  useWorkspaceAddProjectStore.setState({ addingTo: workspaceId });
}

/** The list closed (a pick, Escape, a click away). */
export function closeWorkspaceAddProject(): void {
  useWorkspaceAddProjectStore.setState({ addingTo: null });
}
