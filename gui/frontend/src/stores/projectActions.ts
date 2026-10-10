/**
 * Actions behind the Projects page and the workspace member list. Each is a registry
 * command invoked with an explicit context or args (the palette, CLI and keybindings
 * reach the same code), or a selection change.
 */
import { startCommandNamed } from "@/keys/bindings";
import { repoRef } from "@/lib/projects";
import { openAddProject } from "./addProject";
import { runCommand } from "./commands";
import { repoContext, worktreeContext } from "./context";
import { useReposStore } from "./repos";
import { useWorkspacesStore } from "./workspaces";

/** terminal.new in the worktree. */
export function newTerminalIn(repoId: string, path: string): Promise<boolean> {
  return runCommand("terminal.new", {}, worktreeContext(repoId, path));
}

/** repo.worktree.remove (the daemon asks for confirmation; dirty worktrees are refused without force). */
export function removeWorktree(repoId: string, path: string): Promise<boolean> {
  return runCommand("repo.worktree.remove", {}, worktreeContext(repoId, path));
}

/** repo.unregister (confirmed). */
export function unregisterProject(repoId: string): Promise<boolean> {
  return runCommand("repo.unregister", {}, repoContext(repoId));
}

/**
 * repo.add: the Add Project dialog. Opened directly when the daemon does not list
 * repo.add (one older than the dialog): its Local folder tab still works there.
 */
export function addProject(): void {
  if (!startCommandNamed("repo.add")) openAddProject();
}

function wsName(workspaceId: string): string {
  return useWorkspacesStore.getState().byId[workspaceId]?.name ?? workspaceId;
}

/** workspace.add-repo: a worktree on the workspace branch in another project. */
export function addToWorkspace(workspaceId: string, repoId: string): Promise<boolean> {
  return runCommand("workspace.add-repo", { repo: repoRef(useReposStore.getState(), repoId), workspace: workspaceId });
}

/** workspace.remove-repo (confirmed; refused while a thread runs there or with changes). */
export function removeFromWorkspace(workspaceId: string, repoId: string): Promise<boolean> {
  return runCommand("workspace.remove-repo", { repo: repoRef(useReposStore.getState(), repoId), workspace: workspaceId });
}

/** workspace.remove (confirmed): every member worktree is deleted. Named by name, which reads better in the prompt. */
export function removeWorkspace(workspaceId: string): Promise<boolean> {
  return runCommand("workspace.remove", { workspace: wsName(workspaceId) });
}
