/**
 * Questions the window asks before it runs a command for the user, before the daemon sees it:
 * work only this window holds that the command would end for good (a File tab's unsaved edits
 * when its thread is archived, stores/fileEditGuards.ts). The app's own callers run them
 * (runCommandForResult: buttons, menus, the palette, keys; removeSpace); a page's or a thread's
 * command does not, and what it ends is kept instead. A guard that says no stops the command
 * quietly, as declining a confirmation does.
 */
import type { UiContextView } from "@/api/command";

/** Resolves whether the command may run. */
export type CommandGuard = (args: Readonly<Record<string, string>>, ctx: UiContextView) => boolean | Promise<boolean>;

const guards = new Map<string, Set<CommandGuard>>();

/** Adds a guard for a command; returns its removal. */
export function registerCommandGuard(command: string, guard: CommandGuard): () => void {
  let set = guards.get(command);
  if (!set) {
    set = new Set();
    guards.set(command, set);
  }
  set.add(guard);
  return () => {
    guards.get(command)?.delete(guard);
  };
}

/**
 * Runs a command's guards in turn: true at once when none asks (so a command with no guard
 * reaches the daemon in the same tick), else whether all of them let it run.
 */
export function guardCommand(command: string, args: Readonly<Record<string, string>>, ctx: UiContextView): true | Promise<boolean> {
  const list = [...(guards.get(command) ?? [])];
  const run = async (from: number): Promise<boolean> => {
    for (const guard of list.slice(from)) {
      if (!(await guard(args, ctx))) return false;
    }
    return true;
  };
  for (let i = 0; i < list.length; i++) {
    const answer = list[i]?.(args, ctx);
    if (answer === false) return Promise.resolve(false);
    if (answer !== true && answer !== undefined) return answer.then((ok) => (ok ? run(i + 1) : false));
  }
  return true;
}
