/**
 * The terminal label contract (internal/termlabel, proto Terminal.labels). A shell
 * terminal.new starts carries kind=shell, repo and worktree, plus thread when a thread
 * owns it. An action run in a terminal (action.run) carries kind=action, the same owner
 * labels, and the action, its name at the start, and the run. Threads have no terminal of
 * their own (Claude runs headless), but only kind identifies a panel terminal: a terminal
 * from a raw TerminalService.Create may carry any labels, and the bottom panel shows
 * shells and action runs only.
 */
export const KIND_LABEL = "kind";
export const REPO_LABEL = "repo";
/** The worktree path the terminal belongs to (the snapshot path, symlinks resolved). */
export const WORKTREE_LABEL = "worktree";
/** The thread that owns the terminal: a shell or an action run started for it. */
export const SESSION_LABEL = "thread";
/** An action run's action id, its name when the run started, and the run's id. */
export const ACTION_LABEL = "action";
export const ACTION_NAME_LABEL = "action.name";
export const ACTION_RUN_LABEL = "action.run";
export const KIND_SHELL = "shell";
export const KIND_ACTION = "action";

/** Whether the labels mark a shell terminal.new started. */
export function isShellLabels(labels: Readonly<Record<string, string>>): boolean {
  return labels[KIND_LABEL] === KIND_SHELL;
}

/** Whether the labels mark an action run's terminal (action.run). */
export function isActionLabels(labels: Readonly<Record<string, string>>): boolean {
  return labels[KIND_LABEL] === KIND_ACTION;
}

/** Whether the bottom panel shows the terminal: a shell or an action run (termlabel.IsPanel). */
export function isPanelLabels(labels: Readonly<Record<string, string>>): boolean {
  return isShellLabels(labels) || isActionLabels(labels);
}
