/**
 * The terminal label contract (internal/termlabel, proto Terminal.labels). A shell
 * terminal.new starts carries kind=shell, repo and worktree, plus session when a thread
 * owns it. Threads have no terminal of their own (Claude runs headless), but only
 * kind=shell identifies a shell: a terminal from a raw TerminalService.Create may carry
 * any labels, and the bottom panel shows shells only.
 */
export const KIND_LABEL = "kind";
export const REPO_LABEL = "repo";
/** The worktree path the terminal belongs to (the snapshot path, symlinks resolved). */
export const WORKTREE_LABEL = "worktree";
/** The thread that owns the terminal: a shell started for it. */
export const SESSION_LABEL = "session";
export const KIND_SHELL = "shell";

/** Whether the labels mark a shell terminal.new started. */
export function isShellLabels(labels: Readonly<Record<string, string>>): boolean {
  return labels[KIND_LABEL] === KIND_SHELL;
}
