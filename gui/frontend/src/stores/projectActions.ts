/**
 * Actions behind the Projects page and the workspace member list. Each is a registry
 * command invoked with an explicit context or args (the palette, CLI and keybindings
 * reach the same code), or a selection change.
 */
import { startCommandNamed } from "@/keys/bindings";
import { openAddProject } from "./addProject";
import { newTerminalInContext } from "@/shell/terminalActions";
import { toastCleanupResult } from "./cleanupWorktrees";
import { runCommand, runCommandForResult } from "./commands";
import { composeIn } from "./compose";
import { projectContext, worktreeContext } from "./context";
import { openPublishDialog } from "./publish";
import { mainWorktreePath, useProjectsStore } from "./projects";
import { archiveThread } from "./threadActions";
import { useUiStore } from "./ui";

/** terminal.new in the worktree; its tab opens (focused) in the focused pane. */
export function newTerminalIn(projectId: string, path: string): Promise<boolean> {
  return newTerminalInContext(worktreeContext(projectId, path));
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
 * project.worktree.cleanup for every merged, clean, unheld worktree of the project
 * (confirmed in the cleanup dialog, which lists them). A worktree with uncommitted work is
 * never part of it. The result toast names only what went.
 */
export async function cleanupMergedWorktrees(projectId: string): Promise<boolean> {
  return reportCleanup(await runCommandForResult("project.worktree.cleanup", { project: projectId }, { ctx: projectContext(projectId), quiet: true }));
}

function reportCleanup(res: { resultJson: string } | null): boolean {
  if (!res) return false;
  toastCleanupResult(res.resultJson);
  return true;
}

/** worktree.reveal on the project's main checkout (a folder without git: the folder). */
export function revealProject(projectId: string): Promise<boolean> {
  const main = mainWorktreePath(useProjectsStore.getState(), projectId);
  return runCommand("worktree.reveal", { worktree: main }, worktreeContext(projectId, main));
}

/** project.unregister (confirmed). */
export function unregisterProject(projectId: string): Promise<boolean> {
  return runCommand("project.unregister", {}, projectContext(projectId));
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

