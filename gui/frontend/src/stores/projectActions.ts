/**
 * Actions behind the Projects page and the workspace member list. Each is a registry
 * command invoked with an explicit context or args (the palette, CLI and keybindings
 * reach the same code), or a selection change.
 */
import { startCommandNamed } from "@/keys/bindings";
import { repoRef } from "@/lib/projects";
import { runCommand } from "./commands";
import { getUiContext } from "./context";
import { useReposStore } from "./repos";
import { useUiStore } from "./ui";
import { useWorkspacesStore } from "./workspaces";

function worktreeContext(repoId: string, path: string) {
  return getUiContext({ kind: "worktree", repoId, path });
}

/** The project's overview page (its main worktree). */
export function openProject(repoId: string): void {
  useUiStore.getState().select({ kind: "repo", repoId });
}

/** The worktree's overview page. */
export function openWorktree(repoId: string, path: string): void {
  useUiStore.getState().select({ kind: "worktree", repoId, path });
}

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
  return runCommand("repo.unregister", {}, getUiContext({ kind: "repo", repoId }));
}

/** repo.register: the palette asks for the path. */
export function registerProject(): boolean {
  return startCommandNamed("repo.register");
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
