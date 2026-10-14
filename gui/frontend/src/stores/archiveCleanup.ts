/**
 * When a thread is archived or snoozed (from this window, another one, or the CLI), its
 * side panel and bottom panel entries are reset: the side panel's tabs go and it is
 * closed, and the bottom panel is closed (the daemon removed the thread's shells, so its
 * tabs went on their own). Reacting to the sessions store rather than wrapping
 * archiveSession / snoozeSession makes every archive and snooze behave the same. Only a
 * transition counts (archivedAtMs or snoozedUntilMs null to set, on a thread this window
 * already knew), so panels opened later on an archived or snoozed thread are left alone,
 * a re-snooze to another time resets nothing, and neither does the first snapshot.
 * See docs/notes/archive-threads-2-sidebar.md and snooze-threads-2-sidebar.md.
 */
import { emptyBottom, useBottomStore } from "./bottomPanel";
import { emptyEntry, keyOf, usePanelStore } from "./panel";
import { useSessionsStore, type SessionsData } from "./sessions";

/** The fields whose null → set transition puts a thread away. */
type PutAwayField = "archivedAtMs" | "snoozedUntilMs";

/** Ids whose `field` was set between two session sets: known and unset before, set now. */
function newlySet(prev: SessionsData, next: SessionsData, field: PutAwayField): string[] {
  if (prev.byId === next.byId) return [];
  return next.order.filter((id) => {
    const was = prev.byId[id];
    return was !== undefined && was[field] === null && (next.byId[id]?.[field] ?? null) !== null;
  });
}

/** Ids archived between two session sets: known and not archived before, archived now. */
export function newlyArchived(prev: SessionsData, next: SessionsData): string[] {
  return newlySet(prev, next, "archivedAtMs");
}

/** Ids snoozed between two session sets: known and not snoozed before, snoozed now. */
export function newlySnoozed(prev: SessionsData, next: SessionsData): string[] {
  return newlySet(prev, next, "snoozedUntilMs");
}

/** Resets a thread's side panel (no tabs, closed) and bottom panel (closed) entries. */
export function resetThreadPanels(id: string): void {
  const key = keyOf({ kind: "session", id });
  if (key === null) return;
  if (key in usePanelStore.getState().byKey) usePanelStore.setState((s) => ({ byKey: { ...s.byKey, [key]: emptyEntry } }));
  if (key in useBottomStore.getState().byKey) useBottomStore.setState((s) => ({ byKey: { ...s.byKey, [key]: emptyBottom } }));
}

/** Starts resetting archived and snoozed threads' panels; returns the unsubscribe. */
export function startArchiveCleanup(): () => void {
  return useSessionsStore.subscribe((s, prev) => {
    for (const id of new Set([...newlyArchived(prev, s), ...newlySnoozed(prev, s)])) resetThreadPanels(id);
  });
}
