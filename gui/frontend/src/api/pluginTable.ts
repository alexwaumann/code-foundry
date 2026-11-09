/**
 * The view model's table node (pluginsdk/ui table.go): rows of cells under column headers
 * that drop, least important first, as the table narrows. docs/notes/plugin-table.md.
 */
import type { Glyph, Inline, Pill, ViewAction, ViewButton, ViewMenu } from "./plugin";

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

/** A cell: an Inline alone, or {value, glyph, pill}. */
export type TableCell = Inline | { value?: Inline; glyph?: Glyph; pill?: Pill };

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
