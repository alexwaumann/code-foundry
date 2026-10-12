/**
 * Actions behind the Projects page and the workspace member list. Each is a registry
 * command invoked with an explicit context or args (the palette, CLI and keybindings
 * reach the same code), or a selection change.
 */
import { startCommandNamed } from "@/keys/bindings";
import { repoRef } from "@/lib/projects";
import { openAddProject } from "./addProject";
import { newWorktreeTerminal } from "./bottomActions";
import { runCommand, runCommandForResult } from "./commands";
import { repoContext, worktreeContext } from "./context";
import { openPublishDialog } from "./publish";
import { mainWorktreePath, useReposStore } from "./repos";
import { useUiStore } from "./ui";
import { useWorkspacesStore } from "./workspaces";

/** terminal.new in the worktree; the shell opens (focused) in the Projects page's bottom panel. */
export function newTerminalIn(repoId: string, path: string): Promise<boolean> {
  return newWorktreeTerminal(repoId, path);
}

/** repo.worktree.remove (the daemon asks for confirmation; dirty worktrees are refused without force). */
export function removeWorktree(repoId: string, path: string): Promise<boolean> {
  return runCommand("repo.worktree.remove", {}, worktreeContext(repoId, path));
}

/** repo.unregister (confirmed). */
export function unregisterProject(repoId: string): Promise<boolean> {
  return runCommand("repo.unregister", {}, repoContext(repoId));
}

/** repo.worktree.new on the project: the palette asks for the branch (base and fetch keep their defaults). */
export function newWorktreeIn(repoId: string): void {
  useUiStore.getState().openPalette("", "repo.worktree.new", repoContext(repoId));
}

/** repo.github.publish's presenter for the project: the publish dialog (owner, name, visibility). */
export function publishProject(repoId: string): void {
  openPublishDialog(repoId);
}

/** repo.git.init: a folder without git becomes a repository with an empty first commit. */
export function initGitIn(repoId: string): Promise<boolean> {
  return runCommand("repo.git.init", { repo: repoId }, repoContext(repoId));
}

/**
 * A project header's Refresh: git.fetch in its main worktree when it has a remote (the
 * gitops toasts report it, a failure included), then repo.refresh for the project, quietly
 * (its result is the header's freshness). A refresh failure is toasted.
 */
export async function refreshProject(repoId: string): Promise<void> {
  const repos = useReposStore.getState();
  const main = mainWorktreePath(repos, repoId);
  if (main && (repos.byId[repoId]?.remotes.length ?? 0) > 0) {
    await runCommandForResult("git.fetch", { worktree: main }, { ctx: worktreeContext(repoId, main), quiet: true });
  }
  await runCommandForResult("repo.refresh", { repo: repoId }, { ctx: repoContext(repoId), quiet: true });
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
