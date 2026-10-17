/**
 * When a thread is archived or snoozed (from this window, another one, or the CLI), its
 * side panel and bottom panel entries are reset: the side panel's tabs go and it is
 * closed, and the bottom panel is closed (the daemon removed the thread's shells, so its
 * tabs went on their own). Reacting to the sessions store rather than wrapping
 * archiveThread / snoozeThread makes every archive and snooze behave the same. Only a
 * transition counts (archivedAtMs or snoozedUntilMs null to set, on a thread this window
 * already knew), so panels opened later on an archived or snoozed thread are left alone,
 * a re-snooze to another time resets nothing, and neither does the first snapshot.
 * The selection follows the same rule: when the selected thread is archived, snoozed or
 * removed (a `removed` event, or a snapshot without it) the window selects the dashboard
 * instead of showing a put-away or missing thread. The dashboard is selected, not
 * focused: the keyboard stays where it was (a row menu, the header). Only the selected
 * thread counts; unarchiving and waking leave the selection alone.
 * See docs/notes/archive-threads-2-sidebar.md, snooze-threads-2-sidebar.md and
 * put-away-focuses-dashboard.md.
 */
import { emptyBottom, useBottomStore } from "./bottomPanel";
import { emptyEntry, keyOf, usePanelStore } from "./panel";
import { useThreadsStore, type ThreadsData } from "./threads";
import { DASHBOARD, useUiStore, type Selection } from "./ui";

/** The fields whose null → set transition puts a thread away. */
type PutAwayField = "archivedAtMs" | "snoozedUntilMs";

/** Ids whose `field` was set between two session sets: known and unset before, set now. */
function newlySet(prev: ThreadsData, next: ThreadsData, field: PutAwayField): string[] {
  if (prev.byId === next.byId) return [];
  return next.order.filter((id) => {
    const was = prev.byId[id];
    return was !== undefined && was[field] === null && (next.byId[id]?.[field] ?? null) !== null;
  });
}

/** Ids archived between two session sets: known and not archived before, archived now. */
export function newlyArchived(prev: ThreadsData, next: ThreadsData): string[] {
  return newlySet(prev, next, "archivedAtMs");
}

/** Ids snoozed between two session sets: known and not snoozed before, snoozed now. */
export function newlySnoozed(prev: ThreadsData, next: ThreadsData): string[] {
  return newlySet(prev, next, "snoozedUntilMs");
}

/** Resets a thread's side panel (no tabs, closed) and bottom panel (closed) entries. */
export function resetThreadPanels(id: string): void {
  const key = keyOf({ kind: "thread", id });
  if (key === null) return;
  if (key in usePanelStore.getState().byKey) usePanelStore.setState((s) => ({ byKey: { ...s.byKey, [key]: emptyEntry } }));
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
 * Starts resetting archived and snoozed threads' panels, and selecting the dashboard when
 * the selected thread is archived, snoozed or removed; returns the unsubscribe.
 */
export function startArchiveCleanup(): () => void {
  return useThreadsStore.subscribe((s, prev) => {
    const putAway = new Set([...newlyArchived(prev, s), ...newlySnoozed(prev, s)]);
    for (const id of putAway) resetThreadPanels(id);
    for (const id of newlyRemoved(prev, s)) putAway.add(id);
    const ui = useUiStore.getState();
    if (putAwaySelected(ui.selection, putAway)) ui.select(DASHBOARD);
  });
}
