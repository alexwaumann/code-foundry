/**
 * When a thread is archived (from this window, another one, or the CLI), its side panel
 * and bottom panel entries are reset: the side panel's tabs go and it is closed, and the
 * bottom panel is closed (the daemon removed the thread's shells, so its tabs went on
 * their own). Reacting to the sessions store rather than wrapping archiveSession makes
 * every archive behave the same. Only a transition counts (archivedAtMs null to set, on a
 * thread this window already knew), so an archived thread's panels opened later are left
 * alone, and loading the first snapshot resets nothing.
 * See docs/notes/archive-threads-2-sidebar.md.
 */
import { emptyBottom, useBottomStore } from "./bottomPanel";
import { emptyEntry, keyOf, usePanelStore } from "./panel";
import { useSessionsStore, type SessionsData } from "./sessions";

/** Ids archived between two session sets: known and not archived before, archived now. */
export function newlyArchived(prev: SessionsData, next: SessionsData): string[] {
  if (prev.byId === next.byId) return [];
  return next.order.filter((id) => {
    const was = prev.byId[id];
    return was !== undefined && was.archivedAtMs === null && (next.byId[id]?.archivedAtMs ?? null) !== null;
  });
}

/** Resets a thread's side panel (no tabs, closed) and bottom panel (closed) entries. */
export function resetThreadPanels(id: string): void {
  const key = keyOf({ kind: "session", id });
  if (key === null) return;
  if (key in usePanelStore.getState().byKey) usePanelStore.setState((s) => ({ byKey: { ...s.byKey, [key]: emptyEntry } }));
  if (key in useBottomStore.getState().byKey) useBottomStore.setState((s) => ({ byKey: { ...s.byKey, [key]: emptyBottom } }));
}

/** Starts resetting archived threads' panels; returns the unsubscribe. */
export function startArchiveCleanup(): () => void {
  return useSessionsStore.subscribe((s, prev) => {
    for (const id of newlyArchived(prev, s)) resetThreadPanels(id);
  });
}
