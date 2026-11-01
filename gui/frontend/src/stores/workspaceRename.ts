/**
 * Which workspace's name is being edited in place, so any surface can start the editor: the workspace page's ⋯
 * Rename, and an index row's (it edits in place while it is the row's workspace). The project twin is
 * stores/projectRename.ts. docs/notes/projects-table-2-context-menus.md.
 */
import { create } from "zustand";

interface WorkspaceRenameState {
  /** The workspace whose name editor is open, or null. One at a time. */
  renamingWorkspaceId: string | null;
}

export const useWorkspaceRenameStore = create<WorkspaceRenameState>()(() => ({ renamingWorkspaceId: null }));

/** Opens the name editor for workspaceId (wherever it shows: the workspace page header, an index row). */
export function startWorkspaceRename(workspaceId: string): void {
  useWorkspaceRenameStore.setState({ renamingWorkspaceId: workspaceId });
}

/** Closes workspaceId's editor; a later start for another workspace is left alone. */
export function endWorkspaceRename(workspaceId: string): void {
  if (useWorkspaceRenameStore.getState().renamingWorkspaceId === workspaceId) useWorkspaceRenameStore.setState({ renamingWorkspaceId: null });
}
