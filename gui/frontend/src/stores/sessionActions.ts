/**
 * Session actions behind buttons, menus and inline edits. Each one is a registry command
 * invoked with an explicit session context, so the palette, keybindings, CLI, and these
 * buttons all reach the same code in the daemon.
 */
import { runCommand, useCommandsStore } from "./commands";
import { getUiContext } from "./context";

export const SESSION_COMMANDS = {
  create: "session.new",
  rename: "session.rename",
  reconnect: "session.reconnect",
  remove: "session.remove",
  close: "session.close",
  fork: "session.fork",
  pin: "session.pin",
  runIn: "session.run-in",
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

export function reconnectSession(id: string): Promise<boolean> {
  return runCommand(SESSION_COMMANDS.reconnect, {}, sessionContext(id));
}

export function removeSession(id: string): Promise<boolean> {
  return runCommand(SESSION_COMMANDS.remove, {}, sessionContext(id));
}

export function closeSession(id: string): Promise<boolean> {
  return runCommand(SESSION_COMMANDS.close, {}, sessionContext(id));
}

export function forkSession(id: string): Promise<boolean> {
  return runCommand(SESSION_COMMANDS.fork, {}, sessionContext(id));
}

/** session.pin with an explicit value (the menu knows the current pin). */
export function pinSession(id: string, pinned: boolean): Promise<boolean> {
  return runCommand(SESSION_COMMANDS.pin, { pinned: String(pinned) }, sessionContext(id));
}

/** session.run-in ("Run in…"): moves a workspace thread to the member in repoId. */
export function runSessionIn(id: string, repoId: string): Promise<boolean> {
  return runCommand(SESSION_COMMANDS.runIn, { repo: repoId }, sessionContext(id));
}
