/**
 * The terminal label contract (internal/termlabel, proto Terminal.labels). A shell
 * terminal.new starts carries kind=shell, project and worktree, plus thread when a thread
 * owns it. An action run in a terminal (action.run) carries kind=action, the same owner
 * labels, and the action, its name at the start, and the run. Threads have no terminal of
 * their own (Claude runs headless), but only kind identifies a panel terminal: a terminal
 * from a raw TerminalService.Create may carry any labels, and the bottom panel shows
 * shells and action runs only.
 */
export const KIND_LABEL = "kind";
export const PROJECT_LABEL = "project";
/** The worktree path the terminal belongs to (the snapshot path, symlinks resolved). */
export const WORKTREE_LABEL = "worktree";
/** The thread that owns the terminal: a shell or an action run started for it. */
export const THREAD_LABEL = "thread";
/** An action run's action id, its name when the run started, and the run's id. */
export const ACTION_LABEL = "action";
export const ACTION_NAME_LABEL = "action.name";
export const ACTION_RUN_LABEL = "action.run";
export const KIND_SHELL = "shell";
export const KIND_ACTION = "action";
/**
 * A plugin's own terminal (terminal/create; docs/notes/plugins-6-thread-terminal.md):
 * kind=plugin, plugin=<name>, title=<the plugin's title>. It belongs to no thread or
 * worktree; the bottom panel shows it only where the user opened it (TerminalsData.shownIn).
 */
export const KIND_PLUGIN = "plugin";
export const PLUGIN_LABEL = "plugin";
export const TITLE_LABEL = "title";
/**
 * A skill's setup script (skill.setup; docs/notes/skills-2-lifecycle.md): kind=setup, the
 * owner labels of a shell, skill=<name> and title="Setup <name>" (its tab's title). Like
 * an action run it stays in the panel after it exits.
 */
export const KIND_SETUP = "setup";
export const SKILL_LABEL = "skill";

/** Whether the labels mark a plugin's own terminal. */
export function isPluginLabels(labels: Readonly<Record<string, string>>): boolean {
  return labels[KIND_LABEL] === KIND_PLUGIN;
}

/** Whether the labels mark a shell terminal.new started. */
export function isShellLabels(labels: Readonly<Record<string, string>>): boolean {
  return labels[KIND_LABEL] === KIND_SHELL;
}

/** Whether the labels mark an action run's terminal (action.run). */
export function isActionLabels(labels: Readonly<Record<string, string>>): boolean {
  return labels[KIND_LABEL] === KIND_ACTION;
}

/** Whether the labels mark a skill's setup script (skill.setup). */
export function isSetupLabels(labels: Readonly<Record<string, string>>): boolean {
  return labels[KIND_LABEL] === KIND_SETUP;
}

/** Whether the bottom panel shows the terminal: a shell, an action run or a skill's setup (termlabel.IsPanel). */
export function isPanelLabels(labels: Readonly<Record<string, string>>): boolean {
  return isShellLabels(labels) || isActionLabels(labels) || isSetupLabels(labels);
}
