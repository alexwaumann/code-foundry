/**
 * The File tab's top line, and the Diff tab's top row, kept across a change of the box's width
 * (docs/notes/shell-20b-gaps.md, docs/notes/shell-gaps-b-surfaces.md).
 * A wrapped line above the view takes another number of rows once the box is wider or narrower,
 * so the same scrollTop shows other lines. In a shell pane that happens on every page zoom
 * change (a pane is a share of the grid, whose layout width is the window's over the zoom) and
 * on every resize of the pane; the classic side panel kept its layout width across zooms, so it
 * did not show there. Pure: the box's rows in, the scroll correction out.
 */

/** A line's row as measured: its number (a diff's: its row index) and its top, in viewport px (a rect). */
export interface LineRow {
  line: number;
  top: number;
  height: number;
}

/** The line at the top of the box and how far its row starts below the box's top, in layout px (negative: cut off above). */
export interface TopLine {
  line: number;
  offset: number;
}

/**
 * The first line whose row shows in the box (`boxTop`..`boxBottom`, viewport px), with its offset
 * from the box's top in layout px (`zoom` is the page zoom). Null when no row shows.
 */
export function topLineOf(rows: readonly LineRow[], boxTop: number, boxBottom: number, zoom: number): TopLine | null {
  let best: LineRow | null = null;
  for (const r of rows) {
    if (r.height <= 0 || r.top + r.height <= boxTop + 1 || r.top >= boxBottom - 1) continue;
    if (!best || r.line < best.line) best = r;
  }
  return best ? { line: best.line, offset: (best.top - boxTop) / zoom } : null;
}

/**
 * How far to scroll (layout px, added to scrollTop) to put `anchor`'s line back where it was;
 * 0 when it is there (within half a pixel), null when its row is not rendered now.
 */
export function topLineCorrection(anchor: TopLine, rows: readonly LineRow[], boxTop: number, zoom: number): number | null {
  const row = rows.find((r) => r.line === anchor.line && r.height > 0);
  if (!row) return null;
  const delta = (row.top - boxTop) / zoom - anchor.offset;
  return Math.abs(delta) < 0.5 ? 0 : delta;
}
