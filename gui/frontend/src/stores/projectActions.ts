/**
 * Actions behind the Projects page and the workspace member list. Each is a registry
 * command invoked with an explicit context or args (the palette, CLI and keybindings
 * reach the same code), or a selection change.
 */
import { startCommandNamed } from "@/keys/bindings";
import { projectRef } from "@/lib/projects";
import { openAddProject } from "./addProject";
import { newWorktreeTerminal } from "./bottomActions";
import { runCommand, runCommandForResult } from "./commands";
import { projectContext, worktreeContext } from "./context";
import { openPublishDialog } from "./publish";
import { mainWorktreePath, useProjectsStore } from "./projects";
import { useUiStore } from "./ui";
import { useWorkspacesStore } from "./workspaces";

/** terminal.new in the worktree; the shell opens (focused) in the Projects page's bottom panel. */
export function newTerminalIn(projectId: string, path: string): Promise<boolean> {
  return newWorktreeTerminal(projectId, path);
}

/** project.worktree.remove (the daemon asks for confirmation, then again, naming the work, before deleting uncommitted changes). */
export function removeWorktree(projectId: string, path: string): Promise<boolean> {
  return runCommand("project.worktree.remove", {}, worktreeContext(projectId, path));
}

/**
 * project.worktree.cleanup for one worktree (confirmed; the daemon fetches, checks again and
 * removes it without touching its branch). The fetch reports through the gitops toasts,
 * the result ("Removed 1 worktree: …" or why it was kept) as a toast.
 */
export function cleanupWorktree(projectId: string, path: string): Promise<boolean> {
  return runCommand("project.worktree.cleanup", { project: projectId, path }, worktreeContext(projectId, path));
}

/**
 * project.worktree.cleanup for every merged, clean, unheld worktree of the project (confirmed; the prompt lists the
 * branches). Merged ones with uncommitted changes are asked about after, with their counts (a second question).
 */
export function cleanupMergedWorktrees(projectId: string): Promise<boolean> {
  return runCommand("project.worktree.cleanup", { project: projectId }, projectContext(projectId));
}

/** project.unregister (confirmed). */
export function unregisterProject(projectId: string): Promise<boolean> {
  return runCommand("project.unregister", {}, projectContext(projectId));
}

/** project.worktree.new on the project: the palette asks for the branch (base and fetch keep their defaults). */
export function newWorktreeIn(projectId: string): void {
  useUiStore.getState().openPalette("", "project.worktree.new", projectContext(projectId));
}

/** project.github.publish's presenter for the project: the publish dialog (owner, name, visibility). */
export function publishProject(projectId: string): void {
  openPublishDialog(projectId);
}

/** project.git.init: a folder without git becomes a repository with an empty first commit. */
export function initGitIn(projectId: string): Promise<boolean> {
  return runCommand("project.git.init", { project: projectId }, projectContext(projectId));
}

/**
 * A project header's Refresh: git.fetch in its main worktree when it has a remote (the
 * gitops toasts report it, a failure included), then project.refresh for the project, quietly
 * (its result is the header's freshness). A refresh failure is toasted.
 */
export async function refreshProject(projectId: string): Promise<void> {
  const projects = useProjectsStore.getState();
  const main = mainWorktreePath(projects, projectId);
  if (main && (projects.byId[projectId]?.remotes.length ?? 0) > 0) {
    await runCommandForResult("git.fetch", { worktree: main }, { ctx: worktreeContext(projectId, main), quiet: true });
  }
  await runCommandForResult("project.refresh", { project: projectId }, { ctx: projectContext(projectId), quiet: true });
}

/**
 * project.add: the Add Project dialog. Opened directly when the daemon does not list
 * project.add (one older than the dialog): its Local folder tab still works there.
 */
export function addProject(): void {
  if (!startCommandNamed("project.add")) openAddProject();
}

function wsName(workspaceId: string): string {
  return useWorkspacesStore.getState().byId[workspaceId]?.name ?? workspaceId;
}

/** workspace.add-project: a worktree on the workspace branch in another project. */
export function addToWorkspace(workspaceId: string, projectId: string): Promise<boolean> {
  return runCommand("workspace.add-project", { project: projectRef(useProjectsStore.getState(), projectId), workspace: workspaceId });
}

/** workspace.remove-project (confirmed; refused while a thread runs there; uncommitted changes are asked about again). */
export function removeFromWorkspace(workspaceId: string, projectId: string): Promise<boolean> {
  return runCommand("workspace.remove-project", { project: projectRef(useProjectsStore.getState(), projectId), workspace: workspaceId });
}

/** workspace.remove (confirmed): every member worktree is deleted. Named by name, which reads better in the prompt. */
export function removeWorkspace(workspaceId: string): Promise<boolean> {
  return runCommand("workspace.remove", { workspace: wsName(workspaceId) });
}
