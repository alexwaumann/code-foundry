/**
 * Session actions behind buttons and inline edits. Each one is a registry command invoked
 * with an explicit session context, so the palette, keybindings, CLI, and these buttons
 * all reach the same code in the daemon.
 */
import { runCommand, useCommandsStore } from "./commands";
import { getUiContext } from "./context";
import { useUiStore } from "./ui";

export const SESSION_COMMANDS = {
  create: "session.new",
  rename: "session.rename",
  reconnect: "session.reconnect",
  remove: "session.remove",
} as const;

function sessionContext(id: string) {
  return getUiContext({ kind: "session", id });
}

/** Opens the palette on session.new for a worktree (its model/effort prompts come from the ArgSpec). */
export function newSessionIn(repoId: string, path: string): void {
  const ui = useUiStore.getState();
  ui.select({ kind: "worktree", repoId, path });
  ui.openPalette("", SESSION_COMMANDS.create);
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
