/**
 * Which project's name is being edited in place, so any surface can start the editor: the project page's ⋯
 * Rename, and an index row's (it edits in place when the row shows the editor for renamingProjectId).
 * docs/notes/projects-table-3-rename.md.
 */
import { create } from "zustand";
import { runCommand } from "./commands";
import { projectContext } from "./context";

interface ProjectRenameState {
  /** The project whose name editor is open, or null. One at a time. */
  renamingProjectId: string | null;
}

export const useProjectRenameStore = create<ProjectRenameState>()(() => ({ renamingProjectId: null }));

/** Opens the name editor for projectId (wherever it shows: the project page header, an index row). */
export function startProjectRename(projectId: string): void {
  useProjectRenameStore.setState({ renamingProjectId: projectId });
}

/** Closes projectId's editor; a later start for another project is left alone. */
export function endProjectRename(projectId: string): void {
  if (useProjectRenameStore.getState().renamingProjectId === projectId) useProjectRenameStore.setState({ renamingProjectId: null });
}

/** project.rename: only the name in Code Foundry changes (the folder, worktrees and branches stay). */
export function renameProject(projectId: string, name: string): Promise<boolean> {
  return runCommand("project.rename", { project: projectId, name: name.trim() }, projectContext(projectId));
}
