/**
 * What the sidebar's selection runs (docs/notes/sidebar-bulk-select.md): its bulk menu, its
 * snooze dialog and the Archived and Snoozed headers as drop targets. Each is one registry
 * command given `ids` (thread.snooze, thread.unread, thread.archive, thread.remove, thread.space.move), never a
 * loop of single commands, so the daemon asks one question for all of them (its DynamicConfirm
 * names the count and the busy ones). The rows show the result (they move or go), so no success
 * toast. Once a command ran, the selection is dropped; a declined question keeps it.
 */
import { afterRev, layoutResultOf, runLayoutCommand } from "@/shell/commands";
import { clearSidebarSelection } from "./sidebarSelection";
import { runCommandForResult } from "./commands";
import { THREAD_COMMANDS, threadContext } from "./threadActions";

/** Runs a thread command on ids (in the first one's context, which the command's availability reads). */
async function onIds(name: string, ids: readonly string[], args: Record<string, string>): Promise<boolean> {
  const first = ids[0];
  if (first === undefined) return false;
  const ok = (await runCommandForResult(name, { ...args, ids: ids.join(",") }, { ctx: threadContext(first), inView: true })) !== null;
  if (ok) clearSidebarSelection();
  return ok;
}

/** thread.snooze --ids: until a time (epoch ms), or unsnooze each with null. */
export function snoozeThreads(ids: readonly string[], untilMs: number | null): Promise<boolean> {
  return onIds(THREAD_COMMANDS.snooze, ids, untilMs === null ? { clear: "true" } : { until: new Date(untilMs).toISOString() });
}

/** thread.snooze --ids --save: each saved for later (no alarm). */
export function saveThreadsForLater(ids: readonly string[]): Promise<boolean> {
  return onIds(THREAD_COMMANDS.snooze, ids, { save: "true" });
}

/** thread.unread --ids: each goes back to Done, as after a turn not seen. */
export function markThreadsUnread(ids: readonly string[]): Promise<boolean> {
  return onIds(THREAD_COMMANDS.markUnread, ids, {});
}

/** thread.archive --ids: archive each, or unarchive each with false. */
export function archiveThreads(ids: readonly string[], archived: boolean): Promise<boolean> {
  return onIds(THREAD_COMMANDS.archive, ids, { archived: String(archived) });
}

/** thread.remove --ids. */
export function removeThreads(ids: readonly string[]): Promise<boolean> {
  return onIds(THREAD_COMMANDS.remove, ids, {});
}

/** thread.space.move --ids: every one to the space, with its linked tabs; the window stays where it is. */
export async function moveThreadsToSpace(ids: readonly string[], space: string): Promise<boolean> {
  const first = ids[0];
  if (first === undefined) return false;
  const res = await runCommandForResult("thread.space.move", { ids: ids.join(","), space }, { quiet: true, ctx: threadContext(first) });
  if (!res) return false;
  clearSidebarSelection();
  const rev = layoutResultOf(res.resultJson)?.rev ?? 0;
  if (rev > 0) await afterRev(rev);
  return true;
}

/** Move to space ▸ New space: a new space after the others (not shown), then every one moves there. */
export async function moveThreadsToNewSpace(ids: readonly string[]): Promise<boolean> {
  const made = await runLayoutCommand("space.new", { focus: "false" });
  if (!made?.space) return false;
  await afterRev(made.rev);
  return moveThreadsToSpace(ids, made.space);
}
