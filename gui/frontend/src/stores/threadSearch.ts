/**
 * The Find dialog's presentation and its hand-offs (search.open, cmd+shift+f;
 * docs/notes/search-4-find-dialog.md). The dialog is a page of the command palette
 * (components/search/SearchDialog.tsx) over every thread. Enter on a message opens its
 * thread with the thread's find bar on that match; Enter on a thread name opens the thread.
 */
import { handoffQuery, type SearchRow } from "@/lib/threadSearch";
import { openThreadFind } from "./threadFind";
import { useUiStore } from "./ui";

/**
 * search.open in this window: the palette's Find dialog. Deferred, so that picked in the
 * palette (which closes after a presenter runs) it reopens on the dialog. Works from any
 * view; the CLI's ShowView reaches every window.
 */
export function presentSearch(): boolean {
  queueMicrotask(() => {
    useUiStore.getState().openSearchPalette();
  });
  return true;
}

/** Closes the palette without handing the keyboard back: what opens next takes it. */
export function closeQuietly(): void {
  useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "palette" } }));
  useUiStore.getState().closePalette();
}

/**
 * Enter on a message: its thread in the content pane, scrolled to the message, with the
 * thread's find bar open on the query (lib/threadSearch handoffQuery: the longest term of
 * several) and the first match in that message current. The bar takes the keyboard.
 */
export function openSearchHit(hit: { threadId: string; itemId: string }, query: string): void {
  closeQuietly();
  useUiStore.getState().select({ kind: "thread", id: hit.threadId });
  openThreadFind(hit.threadId, handoffQuery(query), { itemId: hit.itemId });
}

/** Enter on a thread name: the thread in the content pane, its prompt focused. */
export function openSearchThread(threadId: string): void {
  closeQuietly();
  useUiStore.getState().select({ kind: "thread", id: threadId }, { focusPrompt: true });
}

/**
 * A thread header or "N more" under Messages: the thread with its find bar on the query,
 * from the top of what the list shows (no message named).
 */
export function openSearchThreadFind(threadId: string, query: string): void {
  closeQuietly();
  useUiStore.getState().select({ kind: "thread", id: threadId });
  openThreadFind(threadId, handoffQuery(query));
}

/**
 * Enter (or a click) on a row of the dialog: a hit opens at its message, a name opens the
 * thread, a thread's header or "N more" under Messages opens it with its find bar.
 * Headings and notes do nothing.
 */
export function activateSearchRow(row: SearchRow, query: string): void {
  switch (row.kind) {
    case "hit":
      openSearchHit(row.hit, query);
      return;
    case "name":
      openSearchThread(row.name.threadId);
      return;
    case "group":
    case "more":
      openSearchThreadFind(row.group.threadId, query);
      return;
    default:
  }
}
