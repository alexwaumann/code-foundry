/**
 * When a thread is archived or snoozed (from this window, another one, or the CLI), its
 * side panel and bottom panel entries are reset: the side panel's tabs go and it is
 * closed, and the bottom panel is closed (the daemon removed the thread's shells, so its
 * tabs went on their own). A File tab with unsaved edits stays, and its panel opens, so the
 * user finds it on coming back: this can happen from another window or the CLI, with no one
 * to ask. Removing a thread drops its drafts, since nothing can reach them after; a thread
 * list that failed reports no removal, though it empties the store. Reacting to the threads store rather than wrapping
 * archiveThread / snoozeThread makes every archive and snooze behave the same. Only a
 * transition counts (not archived or snoozed to so, on a thread this window already
 * knew), so panels opened later on an archived or snoozed thread are left alone, a
 * re-snooze to another time or between a time and saved for later resets nothing, and
 * neither does the first snapshot.
 * The selection follows the same rule: when the selected thread is archived, snoozed or
 * removed (a `removed` event, or a snapshot without it) the window selects HOME (the No
 * project composer) instead of showing a put-away or missing thread. HOME is selected,
 * not focused: the keyboard stays where it was (a row menu, the header). Only the
 * selected thread counts; unarchiving and waking leave the selection alone.
 * See docs/notes/archive-threads-2-sidebar.md, snooze-threads-2-sidebar.md,
 * put-away-focuses-dashboard.md and remove-dashboard.md.
 */
import type { ThreadView } from "@/api/threads";
import { isSnoozed } from "@/lib/snooze";
import { emptyBottom, useBottomStore } from "./bottomPanel";
import { dropPanelDrafts, unsavedTabs } from "./fileEdit";
import { emptyEntry, keyOf, usePanelStore, type PanelEntry } from "./panel";
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

/** A side panel after a reset: nothing, or only its tabs with unsaved edits, showing. */
function resetEntry(key: string, entry: PanelEntry): PanelEntry {
  const kept = unsavedTabs(key, entry);
  const first = kept[0];
  return first ? { open: true, groups: [{ tabs: kept, activeTabId: first.id }] } : emptyEntry;
}

/** Resets a thread's side panel (no tabs but unsaved ones, closed without any) and bottom panel (closed) entries. */
export function resetThreadPanels(id: string): void {
  const key = keyOf({ kind: "thread", id });
  if (key === null) return;
  usePanelStore.setState((s) => {
    const entry = s.byKey[key];
    return entry ? { byKey: { ...s.byKey, [key]: resetEntry(key, entry) } } : s;
  });
  if (key in useBottomStore.getState().byKey) useBottomStore.setState((s) => ({ byKey: { ...s.byKey, [key]: emptyBottom } }));
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
 * Starts resetting archived and snoozed threads' panels, and selecting HOME when
 * the selected thread is archived, snoozed or removed; returns the unsubscribe.
 */
export function startArchiveCleanup(): () => void {
  return useThreadsStore.subscribe((s, prev) => {
    const putAway = new Set([...newlyArchived(prev, s), ...newlySnoozed(prev, s)]);
    for (const id of putAway) resetThreadPanels(id);
    for (const id of newlyRemoved(prev, s)) {
      putAway.add(id);
      if (s.availability !== "unavailable") dropPanelDrafts(keyOf({ kind: "thread", id }) ?? "");
    }
    const ui = useUiStore.getState();
    if (putAwaySelected(ui.selection, putAway)) ui.select(HOME);
  });
}
