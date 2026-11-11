/**
 * The view model's table node (pluginsdk/ui table.go): rows of cells under column headers
 * that drop, least important first, as the table narrows. docs/notes/plugin-table.md.
 */
import type { Glyph, Inline, Pill, Tone, ViewAction, ViewButton, ViewMenu } from "./plugin";

export type CellStyle = "" | "muted" | "mono" | "caption";
export type SortDir = "asc" | "desc";

/** One column: a key (its cells' key in each row), an overline label ("" for none), its width and how long it stays as the table narrows. */
export interface TableColumn {
  key: string;
  label?: string;
  align?: "start" | "end";
  /** 1..6 (0 is 1): a share of the free width, never under minWidth. */
  weight?: number;
  /** A fixed width (px). */
  width?: number;
  /** A weighted column's least width (px; 0 is 80). */
  minWidth?: number;
  /** 0..9: the lowest drops first, among equals the rightmost; the first ranked never drops. */
  priority?: number;
  style?: CellStyle;
  sortable?: boolean;
  /** The first click's direction ("" is asc). */
  sortFirst?: "" | SortDir;
}

/**
 * A meter (pluginsdk/ui Meter; docs/notes/plugin-table-meter.md): a bar the cell's width
 * filled to `value` (a fraction, 0..1) with the plugin's own `label` after it ("86%", "3 of
 * 8"; at most 16 characters), its fill in `tone`. Always a cell's whole content.
 */
export interface TableMeter {
  value: number;
  label?: string;
  tone?: Tone;
}

/** A cell: an Inline alone, {value, glyph, pill}, or {meter} (capability view.table.meter). */
export type TableCell = Inline | { value?: Inline; glyph?: Glyph; pill?: Pill } | { meter: TableMeter };

export interface TableRow {
  key: string;
  cells?: Record<string, TableCell>;
  action?: ViewAction;
  actions?: ViewButton[];
  menu?: ViewMenu;
  selected?: boolean;
}

export interface TableGroup {
  key: string;
  label: string;
  /** Shown after the label; the row count when absent. */
  count?: number;
  /** How it starts; the user's toggle wins. */
  collapsed?: boolean;
  rows: TableRow[];
}

export interface TableSort {
  column: string;
  dir: SortDir;
}

/** Rows (or groups of rows) under 1..10 columns; the plugin sorts, the host draws `sort`'s arrow. */
export interface TableData {
  title?: string;
  count?: number;
  columns: TableColumn[];
  rows?: TableRow[];
  groups?: TableGroup[];
  sort?: TableSort;
  dense?: boolean;
  emptyText?: string;
}
