/**
 * What the sidebar's bulk menu offers for a selection (docs/notes/sidebar-bulk-select.md): only
 * the actions that apply to every selected thread, by the single row menu's rules
 * (components/thread/ThreadMenuItems.tsx): no Snooze ▸ while one of them is still being set up,
 * Unsnooze only when all are snoozed (or saved), Mark as unread only when every one can be marked
 * (lib/markUnread.ts), Unarchive instead of Archive when all are archived, neither when they are
 * mixed. Move to space ▸ and Remove apply to any thread.
 */
import { canMarkUnread, type MarkUnreadFacts } from "./markUnread";
import { isSnoozed } from "./snooze";

/** What the rules read of one selected thread (stores/threads' entry). */
export type BulkThreadFacts = MarkUnreadFacts;

export interface BulkMenuItems {
  snooze: boolean;
  unsnooze: boolean;
  unread: boolean;
  /** Archive, Unarchive, or neither (a mix of both). */
  archive: "archive" | "unarchive" | null;
  move: boolean;
  remove: boolean;
}

export function bulkMenuItems(threads: readonly BulkThreadFacts[]): BulkMenuItems {
  const all = (f: (t: BulkThreadFacts) => boolean) => threads.length > 0 && threads.every(f);
  const archived = (t: BulkThreadFacts) => t.archivedAtMs !== null;
  return {
    snooze: all((t) => t.setup?.phase !== "running"),
    unsnooze: all(isSnoozed),
    unread: all(canMarkUnread),
    archive: all((t) => !archived(t)) ? "archive" : all(archived) ? "unarchive" : null,
    move: threads.length > 0,
    remove: threads.length > 0,
  };
}

/**
 * Move to space ▸'s spaces for a selection, in the top bar's order: a space is marked "here"
 * (and offered disabled) only when every selected thread lives there already.
 */
export function bulkSpaceChoices(spaces: readonly { id: string; name: string }[], homes: readonly string[]): { id: string; name: string; here: boolean }[] {
  return spaces.map((s) => ({ ...s, here: homes.length > 0 && homes.every((h) => h === s.id) }));
}
