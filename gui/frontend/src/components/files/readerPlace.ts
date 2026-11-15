/**
 * Where the reader of a code view is, for a caret that must not move the view
 * (docs/notes/file-edit-keep-place.md): the find's current match when it shows, so typing starts
 * where they found it; otherwise the start of the first line whose top is on screen. Pure: rows
 * and rects in, a zero-based place out.
 */
import type { EditorPlace } from "@/lib/codeEditor";
import type { LineRow } from "./topLine";

/** The find's current match: its zero-based line and start, and its rect (viewport px) when it is rendered. */
export interface ShownMatch {
  line: number;
  start: number;
  rect: { top: number; bottom: number } | null;
}

/**
 * `rows`: the rendered lines (1-based `line`, viewport px), in any order; `boxTop`..`boxBottom`:
 * the scroller's rect. A match counts as shown when it is wholly inside the box; a line when its
 * top is (a row cut off above would leave the caret half hidden). With no such line, the first
 * line that shows at all. Null when nothing shows.
 */
export function readerPlace(match: ShownMatch | null, rows: readonly LineRow[], boxTop: number, boxBottom: number): EditorPlace | null {
  const r = match?.rect;
  if (match && r && r.top >= boxTop - 1 && r.bottom <= boxBottom + 1) return { line: match.line, character: match.start };
  let whole: LineRow | null = null;
  let part: LineRow | null = null;
  for (const row of rows) {
    if (row.height <= 0 || row.top >= boxBottom - 1 || row.top + row.height <= boxTop + 1) continue;
    if (!part || row.line < part.line) part = row;
    if (row.top >= boxTop - 1 && (!whole || row.line < whole.line)) whole = row;
  }
  const at = whole ?? part;
  return at ? { line: at.line - 1, character: 0 } : null;
}
