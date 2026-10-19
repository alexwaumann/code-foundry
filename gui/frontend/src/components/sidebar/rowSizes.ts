import type { Row } from "@/lib/tree";

/**
 * The thread list's row sizes in layout px (docs/notes/sidebar-row-emphasis.md). A row's
 * first line is ROW_HEIGHTS[density] (stores/settings.ts): the name, a text-body line
 * (22px), with 3px (compact) or 5px (comfortable) above and below it. A two-line thread row
 * adds SECOND_LINE, exactly the status line's height (a 16px text-caption-sm line plus the
 * 2px gap-0.5 above it), so it keeps the same padding as a single-line row.
 */
export const SECOND_LINE = 18;

/** A footer header's height (Working, Snoozed, Archived): its 22px button sits on the bottom. */
export const HEADER_HEIGHT = 26;

/**
 * Empty space between two thread rows of one panel, on top of each row's own padding. It
 * is the virtualizer's `gap`, so the list's total height and scroll-to-row count it, and a
 * row's own box (its selection, hover and cursor backgrounds) never covers it.
 */
export const ROW_GAP = 4;

/** A row's height: a footer header's, a one-line snoozed or archived row's, or a two-line thread row's. */
export function rowSize(row: Row | undefined, rowHeight: number): number {
  if (row?.kind === "header") return HEADER_HEIGHT;
  return row?.section === "archived" || row?.section === "snoozed" ? rowHeight : rowHeight + SECOND_LINE;
}
