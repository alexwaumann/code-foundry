/**
 * Session actions behind buttons, menus and inline edits. Each one is a registry command
 * invoked with an explicit session context, so the palette, keybindings, CLI, and these
 * buttons all reach the same code in the daemon.
 */
import { runCommand, useCommandsStore } from "./commands";
import { getUiContext } from "./context";

export const SESSION_COMMANDS = {
  create: "thread.new",
  rename: "thread.rename",
  remove: "thread.remove",
  fork: "thread.fork",
  pin: "thread.pin",
  archive: "thread.archive",
  snooze: "thread.snooze",
  runIn: "thread.run-in",
} as const;

/** The context of a thread (its worktree and workspace too), whether or not it is selected. */
export function sessionContext(id: string) {
  return getUiContext({ kind: "session", id });
}

/** The arg session.rename takes the new name in: its first required string arg, else "name". */
export function renameArgName(): string {
  const spec = useCommandsStore.getState().commands.find((c) => c.name === SESSION_COMMANDS.rename);
  return spec?.args.find((a) => a.required && a.type === "string")?.name ?? "name";
}

export function renameSession(id: string, name: string): Promise<boolean> {
  return runCommand(SESSION_COMMANDS.rename, { [renameArgName()]: name }, sessionContext(id));
}

export function removeSession(id: string): Promise<boolean> {
  return runCommand(SESSION_COMMANDS.remove, {}, sessionContext(id));
}

export function forkSession(id: string): Promise<boolean> {
  return runCommand(SESSION_COMMANDS.fork, {}, sessionContext(id));
}

/** session.pin with an explicit value (the menu knows the current pin). */
export function pinSession(id: string, pinned: boolean): Promise<boolean> {
  return runCommand(SESSION_COMMANDS.pin, { pinned: String(pinned) }, sessionContext(id));
}

/**
 * session.archive with an explicit value. Archiving stops Claude, removes the thread's
 * shells and unpins it; the daemon asks for confirmation (runCommand opens the dialog) only
 * while Claude is working, waiting on an answer or running background work. Unarchiving
 * never asks; a message starts Claude again.
 */
export function archiveSession(id: string, archived: boolean): Promise<boolean> {
  return runCommand(SESSION_COMMANDS.archive, { archived: String(archived) }, sessionContext(id));
}

/**
 * session.snooze until an absolute time (epoch ms, sent as RFC 3339; the caller computes
 * presets such as "tomorrow 9 AM" itself), or null to unsnooze. Snoozing stops Claude,
 * removes the thread's shells and unpins and unarchives it; the daemon asks for
 * confirmation (runCommand opens the dialog) only while Claude is working or waiting on an
 * answer, and refuses a time that is not in the future. Unsnoozing never asks.
 */
export function snoozeSession(id: string, untilMs: number | null): Promise<boolean> {
  const args: Record<string, string> = untilMs === null ? { clear: "true" } : { until: new Date(untilMs).toISOString() };
  return runCommand(SESSION_COMMANDS.snooze, args, sessionContext(id));
}

/** session.run-in ("Run in…"): moves a workspace thread to the member in repoId. */
export function runSessionIn(id: string, repoId: string): Promise<boolean> {
  return runCommand(SESSION_COMMANDS.runIn, { repo: repoId }, sessionContext(id));
}
