/**
 * Pure helpers for actions in the GUI (docs/notes/actions-2-gui.md): an action tab's
 * status, its status line's durations, the dimmed command echo above its terminal, and
 * the editor's draft and what Save sends.
 */
import type { ActionIconName, ActionView } from "@/api/actions";

export type ActionTabStatus = "running" | "stopping" | "ok" | "stopped" | "failed";

/**
 * Exit codes of a run the user stopped: terminal.kill sends SIGHUP (129), and SIGKILL (137)
 * after the daemon's grace period when the command ignores it.
 */
const STOPPED_CODES: ReadonlySet<number> = new Set([129, 137]);

/**
 * An action tab's status from its terminal and whether the user pressed Stop on it:
 * running (or stopping, after Stop), exited 0, stopped (exited 129 or 137 after Stop), or
 * failed (anything else, including a command that exits 137 on its own).
 */
export function actionTabStatus(t: { state: string; exitCode: number }, stopRequested = false): ActionTabStatus {
  if (t.state !== "exited") return stopRequested ? "stopping" : "running";
  if (t.exitCode === 0) return "ok";
  return stopRequested && STOPPED_CODES.has(t.exitCode) ? "stopped" : "failed";
}

/** A running run's clock: "0:12", "12:05", "1:02:03". */
export function formatRunClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${String(h)}:${String(m).padStart(2, "0")}:${s}` : `${String(m)}:${s}`;
}

/** A finished run's duration: "4.2s" under 10 s, "42s", "3m 5s", "1h 2m". */
export function formatRunDuration(ms: number): string {
  const d = Math.max(0, ms);
  if (d < 10_000) return `${(Math.floor(d / 100) / 10).toFixed(1)}s`;
  const total = Math.floor(d / 1000);
  if (total < 60) return `${String(total)}s`;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${String(h)}h ${String(m)}m`;
  return `${String(m)}m ${String(total % 60)}s`;
}

/**
 * The command a terminal runs, for the dimmed `$ command` echo: the run's command when the
 * store has it, else the terminal's argv (`[$SHELL, -lc, command]`), else "".
 */
export function actionCommandOf(runCommand: string | undefined, argv: readonly string[]): string {
  if (runCommand) return runCommand;
  return argv.length >= 3 && argv[1] === "-lc" ? (argv[2] ?? "") : "";
}

/** The echo's first line and how many lines follow it (a multi-line command shows "+N lines"). */
export function commandEcho(command: string): { first: string; more: number } {
  const lines = command.split("\n").filter((l) => l.trim() !== "");
  return { first: lines[0] ?? "", more: Math.max(0, lines.length - 1) };
}

/** What the editor edits. Only terminal runs are offered in the GUI (in_terminal stays true). */
export interface ActionDraft {
  name: string;
  command: string;
  icon: ActionIconName;
  onWorktreeCreate: boolean;
}

export const NEW_ACTION_DRAFT: ActionDraft = { name: "", command: "", icon: "play", onWorktreeCreate: false };

export function draftOf(a: ActionView): ActionDraft {
  return { name: a.name, command: a.command, icon: a.icon, onWorktreeCreate: a.onWorktreeCreate };
}

/** Why Save is off before the daemon is asked: a name and a command are both needed. */
export function draftProblem(d: ActionDraft): string | null {
  if (d.name.trim() === "") return "Give the action a name.";
  if (d.command.trim() === "") return "Give the action a command.";
  return null;
}

/**
 * The daemon's refusal as the editor shows it in place. The action store's errors start
 * with their kind (`failed precondition: this project already has an action named "Test"`,
 * internal/store/action wraps its sentinels with %w), which Connect's rawMessage keeps.
 */
export function refusalText(message: string): string {
  return message.replace(/^(?:failed precondition|invalid argument|not found): /, "");
}

/** action.add's args for a new action of project `repoId`. */
export function addArgs(repoId: string, d: ActionDraft): Record<string, string> {
  return {
    name: d.name.trim(),
    command: d.command,
    icon: d.icon,
    "in-terminal": "true",
    "on-worktree-create": String(d.onWorktreeCreate),
    project: repoId,
  };
}

/**
 * action.edit's args: only the fields that changed (the daemon refuses an edit with
 * none, so the caller skips it when this returns null). in-terminal is left alone: an
 * action an agent made a background one stays so.
 */
export function editArgs(a: ActionView, d: ActionDraft): Record<string, string> | null {
  const out: Record<string, string> = {};
  const name = d.name.trim();
  if (name !== a.name) out.name = name;
  if (d.command !== a.command) out.command = d.command;
  if (d.icon !== a.icon) out.icon = d.icon;
  if (d.onWorktreeCreate !== a.onWorktreeCreate) out["on-worktree-create"] = String(d.onWorktreeCreate);
  if (Object.keys(out).length === 0) return null;
  return { action: a.id, ...out, project: a.repoId };
}
