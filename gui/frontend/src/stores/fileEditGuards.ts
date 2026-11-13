/**
 * What the user does that would end a File tab's unsaved edits for good asks first
 * (docs/notes/shell-review-fixes-gui.md): archiving a thread (thread.archive from a button, a
 * menu, the palette or a key) and removing a space with its threads archived (spaceActions
 * removeSpace). Each dirty file of those threads, open or put away, gets the Save, Discard, Keep
 * editing question; Keep editing stops the whole command. Snoozing, closing a thread's tab,
 * moving it or removing a space that moves its threads put the files away with their edits, so
 * they ask nothing. A thread's model or the CLI asks nobody: the edits are kept and come back
 * when the file is opened again for that thread.
 */
import type { UiContextView } from "@/api/command";
import { registerCommandGuard } from "./commandGuards";
import { dirtyEdits } from "./fileEdit";
import { confirmEndEdits } from "./fileRequest";
import { spaceOfThread, useLayoutStore } from "./layout";
import { useThreadsStore } from "./threads";

const ARCHIVE = "thread.archive";

/** The threads a thread.archive call archives (not those it unarchives); [] when it archives none. */
export function threadsArchived(args: Readonly<Record<string, string>>, ctx: Pick<UiContextView, "activeThreadId">): string[] {
  if (args.archived === "false") return [];
  const ids = (args.ids ?? "").split(",").map((x) => x.trim()).filter(Boolean);
  if (ids.length > 0) return ids;
  const id = args.id || ctx.activeThreadId;
  if (!id) return [];
  // Without `archived` it toggles: an archived thread is unarchived.
  if (args.archived === undefined && (useThreadsStore.getState().byId[id]?.archivedAtMs ?? null) !== null) return [];
  return [id];
}

/** The dirty edit sessions of these threads' files, open or not. */
export function dirtyEditsOfThreads(ids: readonly string[]): string[] {
  const panels = new Set(ids.map((id) => `thread:${id}`));
  return dirtyEdits((s) => panels.has(s.panelKey));
}

function threadName(id: string): string {
  const name = useThreadsStore.getState().byId[id]?.name ?? "";
  return name ? `“${name}”` : "this thread";
}

/** Asks about the dirty files of the threads a thread.archive would archive; true when it may run. */
export function guardArchive(args: Readonly<Record<string, string>>, ctx: Pick<UiContextView, "activeThreadId">): Promise<boolean> | true {
  const ids = threadsArchived(args, ctx);
  const keys = dirtyEditsOfThreads(ids);
  if (keys.length === 0) return true;
  const why = ids.length === 1 ? `Archiving ${threadName(ids[0] ?? "")} closes this file for good.` : "Archiving these threads closes this file for good.";
  return confirmEndEdits(keys, why);
}

/** Asks about the dirty files of a space's threads before it is removed with them archived; true when it may go. */
export function guardRemoveSpaceArchive(space: string): Promise<boolean> | true {
  const layout = useLayoutStore.getState();
  const threads = useThreadsStore.getState();
  const ids = threads.order.filter((id) => threads.byId[id]?.archivedAtMs === null && spaceOfThread(layout, id) === space);
  const keys = dirtyEditsOfThreads(ids);
  if (keys.length === 0) return true;
  return confirmEndEdits(keys, "Removing this space archives its threads, which closes this file for good.");
}

/** Registers the guards; returns their removal. */
export function startFileEditGuards(): () => void {
  return registerCommandGuard(ARCHIVE, guardArchive);
}
