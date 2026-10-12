/**
 * The terminal label contract (internal/termlabel, proto Terminal.labels). A shell
 * terminal.new starts carries kind=shell, repo and worktree, plus session when a thread
 * owns it. A thread's Claude terminal has session and worktree too, so `session` alone
 * never identifies a shell.
 */
export const KIND_LABEL = "kind";
export const REPO_LABEL = "repo";
/** The worktree path the terminal belongs to (the snapshot path, symlinks resolved). */
export const WORKTREE_LABEL = "worktree";
/** The thread that owns the terminal: its Claude terminal, or a shell started for it. */
export const SESSION_LABEL = "session";
export const KIND_SHELL = "shell";

/** Whether the labels mark a shell terminal.new started. */
export function isShellLabels(labels: Readonly<Record<string, string>>): boolean {
  return labels[KIND_LABEL] === KIND_SHELL;
}
