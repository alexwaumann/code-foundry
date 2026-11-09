/**
 * The Pull Requests page's table columns (docs/notes/prs-shrink-2-gui.md): each table
 * shows the columns it has room for, dropping the least important first as it narrows.
 * Pure.
 */
import { fitColumns } from "@/components/table/fit";
import type { Section } from "./pageModel";

export type Column = "Repository" | "#" | "Author" | "Title" | "Why" | "Your review" | "Status" | "Checks" | "Comments" | "Diff" | "Age" | "Merged";

/** A column's grid track; `min` is its floor in rem (the track's minmax minimum, or its fixed size). */
interface Track {
  track: string;
  min: number;
}

// Flexible tracks only (fr with a floor): fixed maxima grow before an fr track gets any
// room, which squeezed the title to nothing. Title always shows and takes the leftover.
const TRACKS: Record<Column, Track> = {
  Repository: { track: "minmax(5rem,0.8fr)", min: 5 },
  "#": { track: "4.5rem", min: 4.5 },
  Author: { track: "minmax(5.5rem,0.8fr)", min: 5.5 },
  Title: { track: "minmax(10rem,2.4fr)", min: 10 },
  Why: { track: "minmax(8.5rem,1.3fr)", min: 8.5 },
  "Your review": { track: "minmax(8.5rem,1.3fr)", min: 8.5 },
  Status: { track: "minmax(8.5rem,1.2fr)", min: 8.5 },
  Checks: { track: "minmax(6.5rem,1fr)", min: 6.5 },
  Comments: { track: "4.5rem", min: 4.5 },
  Diff: { track: "minmax(6rem,0.6fr)", min: 6 },
  Age: { track: "3rem", min: 3 },
  Merged: { track: "3.5rem", min: 3.5 },
};

/** Each table's columns in display order. Everything else and Merged group their rows by repository instead of a column. */
export const COLUMNS: Record<Section, readonly Column[]> = {
  review: ["Repository", "#", "Author", "Title", "Why", "Checks", "Diff", "Age"],
  reviewed: ["Repository", "#", "Author", "Title", "Your review", "Checks", "Diff", "Age"],
  authored: ["Repository", "#", "Title", "Status", "Checks", "Comments", "Diff", "Age"],
  else: ["#", "Author", "Title", "Status", "Checks", "Diff", "Age"],
  merged: ["#", "Author", "Title", "Diff", "Merged"],
};

/** Each table's columns from most to least important: the narrower the table, the shorter the prefix it shows. */
export const IMPORTANCE: Record<Section, readonly Column[]> = {
  review: ["Title", "#", "Why", "Repository", "Author", "Checks", "Age", "Diff"],
  reviewed: ["Title", "#", "Your review", "Repository", "Author", "Checks", "Age", "Diff"],
  authored: ["Title", "#", "Status", "Repository", "Checks", "Age", "Comments", "Diff"],
  else: ["Title", "#", "Status", "Author", "Checks", "Age", "Diff"],
  merged: ["Title", "#", "Merged", "Author", "Diff"],
};

/** The right-aligned columns. */
export const RIGHT: ReadonlySet<Column> = new Set<Column>(["Diff", "Age", "Merged"]);

/**
 * A rem in the table's own px. Page zoom is CSS zoom on <html>, which scales px and rem
 * alike, so a measured clientWidth and a rem stay in this ratio.
 */
const REM_PX = 16;

/**
 * The columns a section's table shows at `width` px (its clientWidth: inside the border),
 * in display order: the longest prefix of IMPORTANCE whose floors and gaps fit
 * (components/table/fit.ts). Title and the next two always show, however narrow.
 */
export function visibleColumns(section: Section, width: number): Column[] {
  const ranking = IMPORTANCE[section];
  const keep = new Set(ranking.slice(0, fitColumns(ranking.map((c) => TRACKS[c].min * REM_PX), width, 3)));
  return COLUMNS[section].filter((c) => keep.has(c));
}

/** The grid-template-columns for `cols`. */
export function gridTemplate(cols: readonly Column[]): string {
  return cols.map((c) => TRACKS[c].track).join(" ");
}
