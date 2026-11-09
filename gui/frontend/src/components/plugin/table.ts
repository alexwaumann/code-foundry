/**
 * A plugin table's layout (docs/notes/plugin-table.md): which columns it shows at its
 * width (components/table/fit.ts, as the Pull Requests tables drop theirs), whether its
 * rows' buttons fold into their ⋯ (they go before any column), the grid template, a
 * header click's direction, a cell's parts and the rows under their group labels. Pure:
 * nodes/TableNode.tsx draws it.
 */
import type { Glyph, Inline, Pill } from "@/api/plugin";
import type { CellStyle, SortDir, TableCell, TableColumn, TableData, TableGroup, TableRow, TableSort } from "@/api/pluginTable";
import { fitColumns, TABLE_GAP_PX } from "@/components/table/fit";
import { buttonsWidth } from "./menu";

/** A weighted column's least width when it sets none (pluginsdk/ui TableColumnMinWidth). */
export const COLUMN_MIN_PX = 80;

/** The ⋯ track at a row's end (MoreMenu is 24 px). */
export const MORE_PX = 24;

/** A column's least width (px): its fixed width, else its minWidth. */
export function columnFloor(c: TableColumn): number {
  return c.width ?? c.minWidth ?? COLUMN_MIN_PX;
}

/** A column's grid track: a fixed width, or a share of the free width with its floor. */
export function columnTrack(c: TableColumn): string {
  if (c.width) return `${String(c.width)}px`;
  return `minmax(${String(c.minWidth ?? COLUMN_MIN_PX)}px,${String(c.weight || 1)}fr)`;
}

/** The columns from most to least important: by priority, highest first; among equals the leftmost first. */
export function rankColumns(cols: readonly TableColumn[]): TableColumn[] {
  return cols
    .map((c, i) => ({ c, i }))
    .sort((a, b) => (b.c.priority ?? 0) - (a.c.priority ?? 0) || a.i - b.i)
    .map((x) => x.c);
}

/** A table's rows in order: its rows, or each group's. */
export function allRows(t: TableData): TableRow[] {
  return t.groups ? t.groups.flatMap((g) => g.rows) : (t.rows ?? []);
}

export interface TableLayout {
  /** The columns shown, in display order. */
  columns: TableColumn[];
  /** The grid template: the columns', then the buttons' track, then the ⋯'s. */
  template: string;
  /** The rows' buttons are in their ⋯ menus. */
  folded: boolean;
  /** The buttons' track (px), 0 when there is none (no buttons, or folded). */
  buttons: number;
  /** The rows have a ⋯ track (a row has a menu, or its buttons folded). */
  more: boolean;
}

/**
 * What a table `width` px wide (its clientWidth; null before it is measured: everything)
 * shows. Its rows' buttons (the widest row's) need their own track after the columns: they
 * fold into the rows' ⋯ menus unless every column fits beside them (a dense table always
 * folds labelled buttons, as a dense list does). Then the columns are the longest prefix of
 * the ranking that fits beside the ⋯ and the buttons; the first ranked always shows.
 */
export function tableLayout(t: TableData, width: number | null): TableLayout {
  const rows = allRows(t);
  const room = width ?? Number.POSITIVE_INFINITY;
  const withButtons = rows.filter((r) => (r.actions?.length ?? 0) > 0);
  const anyMenu = rows.some((r) => (r.menu?.items.length ?? 0) > 0);
  const buttonsPx = withButtons.reduce((w, r) => Math.max(w, buttonsWidth(r.actions ?? [])), 0);
  const ranked = rankColumns(t.columns);
  const floors = ranked.map(columnFloor);
  const reserve = (more: boolean, buttons: number) => (more ? MORE_PX + TABLE_GAP_PX : 0) + (buttons > 0 ? buttons + TABLE_GAP_PX : 0);
  let folded = withButtons.length > 0 && t.dense === true && withButtons.some((r) => r.actions?.some((b) => !b.iconOnly));
  if (withButtons.length > 0 && !folded) folded = fitColumns(floors, room - reserve(anyMenu, buttonsPx), 1) < ranked.length;
  const buttons = withButtons.length > 0 && !folded ? buttonsPx : 0;
  const more = anyMenu || (withButtons.length > 0 && folded);
  const keep = new Set(ranked.slice(0, fitColumns(floors, room - reserve(more, buttons), 1)));
  const columns = t.columns.filter((c) => keep.has(c));
  const tracks = columns.map(columnTrack);
  if (buttons > 0) tracks.push(`${String(buttons)}px`);
  if (more) tracks.push(`${String(MORE_PX)}px`);
  return { columns, template: tracks.join(" "), folded, buttons, more };
}

/** The direction a click on `c`'s header asks for (pluginsdk/ui NextSort): the sorted column's other direction, else the column's first. */
export function nextSort(c: TableColumn, sort: TableSort | undefined): SortDir {
  if (sort?.column === c.key) return sort.dir === "desc" ? "asc" : "desc";
  return c.sortFirst === "desc" ? "desc" : "asc";
}

/** A cell's value, glyph and pill (a bare Inline is the value alone; an absent cell is empty). */
export function cellParts(cell: TableCell | undefined): { value?: Inline; glyph?: Glyph; pill?: Pill } {
  if (cell === undefined) return {};
  if (typeof cell === "string") return { value: cell };
  if ("value" in cell || "glyph" in cell || "pill" in cell) return cell;
  // {text, spans}, or {} (an empty cell).
  return "text" in cell || "spans" in cell ? { value: cell } : {};
}

/** Each cell style's classes (a span's own tone wins over the colour). */
export const CELL_STYLE: Record<CellStyle, string> = {
  "": "",
  muted: "text-cf-text-muted",
  mono: "text-code",
  caption: "text-caption",
};

/** One line of a table's body: a group's label, or a row. */
export type TableItem = { kind: "group"; group: TableGroup; count: number; collapsed: boolean } | { kind: "row"; row: TableRow };

/** The body's lines: the rows, or each group's label followed by its rows unless it is collapsed. */
export function tableItems(t: TableData, collapsed: (g: TableGroup) => boolean): TableItem[] {
  if (!t.groups) return (t.rows ?? []).map((row) => ({ kind: "row", row }));
  const out: TableItem[] = [];
  for (const g of t.groups) {
    const c = collapsed(g);
    out.push({ kind: "group", group: g, count: g.count ?? g.rows.length, collapsed: c });
    if (!c) for (const row of g.rows) out.push({ kind: "row", row });
  }
  return out;
}
