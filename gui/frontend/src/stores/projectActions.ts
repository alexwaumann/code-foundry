/**
 * Actions behind the Projects page and the workspace member list. Each is a registry
 * command invoked with an explicit context or args (the palette, CLI and keybindings
 * reach the same code), or a selection change.
 */
import { startCommandNamed } from "@/keys/bindings";
import { openAddProject } from "./addProject";
import { newWorktreeTerminal } from "./bottomActions";
import { runCommand, runCommandForResult } from "./commands";
import { composeIn } from "./compose";
import { projectContext, worktreeContext } from "./context";
import { openPublishDialog } from "./publish";
import { mainWorktreePath, useProjectsStore } from "./projects";
import { archiveThread } from "./threadActions";
import { useUiStore } from "./ui";

/** terminal.new in the worktree; the shell opens (focused) in the Projects page's bottom panel. */
export function newTerminalIn(projectId: string, path: string): Promise<boolean> {
  return newWorktreeTerminal(projectId, path);
}

/**
 * project.worktree.remove, confirmed in the remove-worktree dialog (stores/removeWorktree.ts:
 * the path that goes, the branch that stays, the uncommitted files that are lost). The path
 * is passed as an arg so the dialog knows the worktree.
 */
export function removeWorktree(projectId: string, path: string): Promise<boolean> {
  return runCommand("project.worktree.remove", { path }, worktreeContext(projectId, path));
}

/**
 * A leftover worktree's Resume: the newest archived thread that worked there, unarchived
 * (thread.archive) and shown with its prompt focused; with none, the composer in that
 * checkout.
 */
export async function resumeWorktree(projectId: string, path: string, archivedThreadId: string | null): Promise<void> {
  if (archivedThreadId === null) {
    composeIn(projectId, path);
    return;
  }
  if (await archiveThread(archivedThreadId, false)) useUiStore.getState().select({ kind: "thread", id: archivedThreadId }, { focusPrompt: true });
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

