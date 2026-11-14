/**
 * When a thread is archived, snoozed or removed (from this window, another one, or the CLI):
 * where its tabs go is the layout's (the daemon closes them, docs/notes/shell-6-lifecycle.md).
 * Removing a thread drops its file drafts and its recent files entry, since nothing can reach
 * them after; a thread list that failed reports no removal, though it empties the store. Only a
 * transition counts (not archived or snoozed to so, on a thread this window already knew).
 * The selection follows the same rule: when the selected thread is archived, snoozed or
 * removed (a `removed` event, or a snapshot without it) the window selects HOME (the No
 * project composer) instead of showing a put-away or missing thread. Only the selected thread
 * counts; unarchiving and waking leave the selection alone.
 * See docs/notes/archive-threads-2-sidebar.md, snooze-threads-2-sidebar.md,
 * put-away-focuses-dashboard.md and remove-dashboard.md.
 */
import type { ThreadView } from "@/api/threads";
import { isSnoozed } from "@/lib/snooze";
import { dropPanelDrafts } from "./fileEdit";
import { targetOf } from "@/shell/host";
import { useRecentFilesStore } from "./recentFiles";
import { useThreadsStore, type ThreadsData } from "./threads";
import { HOME, useUiStore, type Selection } from "./ui";

/** Ids that became `is` between two thread sets: known and not so before, so now. */
function newly(prev: ThreadsData, next: ThreadsData, is: (t: ThreadView) => boolean): string[] {
  if (prev.byId === next.byId) return [];
  return next.order.filter((id) => {
    const was = prev.byId[id];
    const now = next.byId[id];
    return was !== undefined && now !== undefined && !is(was) && is(now);
  });
}

/** Ids archived between two thread sets: known and not archived before, archived now. */
export function newlyArchived(prev: ThreadsData, next: ThreadsData): string[] {
  return newly(prev, next, (t) => t.archivedAtMs !== null);
}

/** Ids snoozed, in either form, between two thread sets: known and not snoozed before, snoozed now. */
export function newlySnoozed(prev: ThreadsData, next: ThreadsData): string[] {
  return newly(prev, next, isSnoozed);
}

function without<T>(byKey: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const { [key]: _gone, ...rest } = byKey;
  return rest;
}

/** Drops a removed thread's file drafts and its recent files entry. */
function forgetThread(id: string): void {
  const key = targetOf({ kind: "thread", id });
  if (key === null) return;
  dropPanelDrafts(key);
  if (key in useRecentFilesStore.getState().byKey) useRecentFilesStore.setState((s) => ({ byKey: without(s.byKey, key) }));
}

/** Ids the store had before and not now (a removed event, or a snapshot without them). */
export function newlyRemoved(prev: ThreadsData, next: ThreadsData): string[] {
  if (prev.byId === next.byId) return [];
  return prev.order.filter((id) => !(id in next.byId));
}

/** True when the selection is a thread among `putAway` (archived, snoozed or removed just now). */
export function putAwaySelected(selection: Selection, putAway: ReadonlySet<string>): boolean {
  return selection.kind === "thread" && putAway.has(selection.id);
}

/**
 * Starts forgetting removed threads' drafts, and selecting HOME when the selected thread is
 * archived, snoozed or removed; returns the unsubscribe.
 */
export function startArchiveCleanup(): () => void {
  return useThreadsStore.subscribe((s, prev) => {
    const putAway = new Set([...newlyArchived(prev, s), ...newlySnoozed(prev, s)]);
    for (const id of newlyRemoved(prev, s)) {
      putAway.add(id);
      if (s.loaded) forgetThread(id);
    }
    const ui = useUiStore.getState();
    if (putAwaySelected(ui.selection, putAway)) ui.select(HOME);
  });
}
