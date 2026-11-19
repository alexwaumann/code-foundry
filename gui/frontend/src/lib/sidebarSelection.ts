/**
 * The sidebar's multi-selection of thread rows, as pure functions (docs/notes/sidebar-bulk-select.md):
 * Finder's list-view rules. Cmd-click toggles a row and makes it the anchor; shift-click selects
 * every shown row between the anchor and the clicked one, replacing the range the last
 * shift-click from that anchor made (the rows selected before it stay); a thread that leaves
 * the list leaves the selection. `order` is every thread row shown, in display order.
 * stores/sidebarSelection.ts holds the state; the rows and ThreadListbox call these through it.
 */

export interface Selection {
  /** The selected threads, in the order they were added (sorted by `inOrder` when acted on). */
  ids: readonly string[];
  /** The row shift-click stretches from: the last row clicked or cmd-clicked. */
  anchor: string | null;
  /** The selection before the current shift-range, which a new shift-click keeps; null when no range is open. */
  base: readonly string[] | null;
}

export const EMPTY_SELECTION: Selection = { ids: [], anchor: null, base: null };

/** Cmd-click: the row joins the selection, or leaves it; either way it is the anchor and ends a range. */
export function toggleRow(sel: Selection, id: string): Selection {
  const ids = sel.ids.includes(id) ? sel.ids.filter((x) => x !== id) : [...sel.ids, id];
  return { ids, anchor: id, base: null };
}

/**
 * Shift-click on `id`: every row of `order` from the anchor to it, both included, added to what was
 * selected before the range began. With no anchor (nothing selected) the anchor is `fallback`, the
 * open thread's row. An anchor or row not shown (not in `order`) selects just the clicked row and
 * makes it the anchor.
 */
export function rangeTo(sel: Selection, id: string, order: readonly string[], fallback: string | null): Selection {
  const anchor = sel.anchor ?? (sel.ids.length === 0 ? fallback : null);
  const from = anchor === null ? -1 : order.indexOf(anchor);
  const to = order.indexOf(id);
  if (to < 0) return sel;
  if (from < 0) return { ids: [id], anchor: id, base: null };
  const base = sel.base ?? (sel.anchor === null ? [] : sel.ids);
  const range = order.slice(Math.min(from, to), Math.max(from, to) + 1);
  const ids = [...base, ...range.filter((x) => !base.includes(x))];
  return { ids, anchor, base };
}

/** The selection with only the threads still shown: a thread that left the list leaves it; so does an anchor. */
export function pruneTo(sel: Selection, order: readonly string[]): Selection {
  const shown = new Set(order);
  const keep = (ids: readonly string[]) => ids.filter((x) => shown.has(x));
  const ids = keep(sel.ids);
  const anchor = sel.anchor !== null && shown.has(sel.anchor) ? sel.anchor : null;
  const base = sel.base === null ? null : keep(sel.base);
  if (ids.length === sel.ids.length && anchor === sel.anchor && (base === null || base.length === sel.base?.length)) return sel;
  return { ids, anchor, base };
}

/** The selected threads in display order (what an action or a drag acts on). */
export function inOrder(sel: Selection, order: readonly string[]): string[] {
  const picked = new Set(sel.ids);
  return order.filter((x) => picked.has(x));
}
