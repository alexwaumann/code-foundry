/**
 * How a bordered table (the Pull Requests page's, a plugin's Table node) narrows: it drops
 * columns, least important first, rather than squeezing them or scrolling sideways
 * (docs/notes/prs-shrink-2-gui.md, docs/notes/plugin-table.md). Pure.
 */

/** The gap between columns (gap-3), in px. */
export const TABLE_GAP_PX = 12;

/** A row's horizontal padding (px-2 each side) inside the body's p-0.5, in px: what a row's columns cannot use. */
export const TABLE_INSET_PX = 16 + 4;

/**
 * How many of a ranking's columns (most important first; `floors` their least widths in
 * px) a table `width` px wide (its clientWidth: inside the border) shows: the longest
 * prefix whose floors and gaps fit, and at least `keep`, however narrow.
 */
export function fitColumns(floors: readonly number[], width: number, keep: number): number {
  const room = width - TABLE_INSET_PX;
  let used = 0;
  let n = 0;
  for (const [i, floor] of floors.entries()) {
    const need = floor + (n > 0 ? TABLE_GAP_PX : 0);
    if (i >= keep && used + need > room) break;
    used += need;
    n++;
  }
  return n;
}
