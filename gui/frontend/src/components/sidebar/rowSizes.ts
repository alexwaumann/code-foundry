import type { Row } from "@/lib/tree";

/**
 * The thread list's row sizes in layout px (docs/notes/sidebar-row-emphasis.md). A snoozed
 * or archived row is one line, ROW_HEIGHTS[density] (stores/settings.ts): the name, a
 * text-body line (22px), with 3px (compact) or 5px (comfortable) above and below it.
 *
 * A thread row in the inbox layout (docs/notes/sidebar-inbox-2-libs.md), whatever the
 * density: three lines with no gap between them, a text-caption-sm project and status line
 * (16px), the text-body name (22px) and a text-caption-sm detail or branch line (16px), with
 * 3px above and below. Every thread row but a snoozed or archived one (still one line,
 * ROW_HEIGHTS[density]) has it.
 */
export const THREE_LINE_ROW = 60;

/** A footer header's height (Working, Snoozed, Archived): its 22px button sits on the bottom. */
export const HEADER_HEIGHT = 26;

/**
 * Empty space between two thread rows of one panel, on top of each row's own padding. It
 * is the virtualizer's `gap`, so the list's total height and scroll-to-row count it, and a
 * row's own box (its selection, hover and cursor backgrounds) never covers it.
 */
export const ROW_GAP = 4;

/**
 * A row's height: a footer header's, a one-line snoozed or archived row's (`rowHeight`, by
 * density), or a three-line thread row's (THREE_LINE_ROW; also for a row out of range).
 */
export function rowSize(row: Row | undefined, rowHeight: number): number {
  if (row?.kind === "header") return HEADER_HEIGHT;
  return row?.section === "archived" || row?.section === "snoozed" ? rowHeight : THREE_LINE_ROW;
}
