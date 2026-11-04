import type { Row, Section } from "@/lib/tree";

/**
 * The thread list's row sizes in layout px (docs/notes/sidebar-row-emphasis.md).
 *
 * A thread row in the inbox layout (docs/notes/sidebar-inbox-2-libs.md): three lines with no
 * gap between them, a text-caption-sm project and status line (16px), the text-body name
 * (22px) and a text-caption-sm detail or branch line (16px), with 3px above and below. Every
 * thread row but a snoozed or archived one (ONE_LINE_ROW) has it.
 */
export const THREE_LINE_ROW = 60;

/**
 * A snoozed or archived row: one text-body line (22px) with 1px above and below, so with
 * QUIET_ROW_GAP two names sit 4px apart (docs/notes/quiet-rows-tighter.md).
 */
export const ONE_LINE_ROW = 24;

/** A footer header's height (Working, Snoozed, Archived): its 22px button sits on the bottom. */
export const HEADER_HEIGHT = 26;

/**
 * Empty space between two thread rows of one panel, on top of each row's own padding. It
 * is the virtualizer's `gap`, so the list's total height and scroll-to-row count it, and a
 * row's own box (its selection, hover and cursor backgrounds) never covers it.
 */
export const ROW_GAP = 8;

/** ROW_GAP for the one-line rows of Snoozed and Archived, which read as a compact list. */
export const QUIET_ROW_GAP = 2;

/** Whether a section's thread rows are one line (ONE_LINE_ROW), not three. */
function isQuiet(section: Section | undefined): boolean {
  return section === "archived" || section === "snoozed";
}

/** The space between two thread rows of a section's panel. */
export function rowGap(section: Section): number {
  return isQuiet(section) ? QUIET_ROW_GAP : ROW_GAP;
}

/**
 * A row's height: a footer header's, a one-line snoozed or archived row's (ONE_LINE_ROW), or
 * a three-line thread row's (THREE_LINE_ROW; also for a row out of range).
 */
export function rowSize(row: Row | undefined): number {
  if (row?.kind === "header") return HEADER_HEIGHT;
  return isQuiet(row?.section) ? ONE_LINE_ROW : THREE_LINE_ROW;
}
