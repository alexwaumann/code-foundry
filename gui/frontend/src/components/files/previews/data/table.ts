/**
 * What the data grid (DataGrid.tsx) shows, whatever the file: columns, rows in file order,
 * and per cell a sort key and the text a spreadsheet gets. The CSV and JSON Lines models
 * (csvTable.ts, jsonlTable.ts) build one; sorting and the tab-separated copy are here. Pure.
 */

export interface Column {
  /** The header's text; "" for a column with no name (a blank header, a ragged row's extra field). */
  readonly name: string;
  /** Every value present is a number: right-aligned, sorted as numbers. */
  readonly numeric: boolean;
  /** Characters wide, from the longest value (capped), for the column's width. */
  readonly width: number;
}

/** A cell's sort key: a number in a numeric column, else text; null (empty, missing) sorts last either way. */
export type SortKey = number | string | null;

export interface Sort {
  readonly col: number;
  readonly dir: "asc" | "desc";
}

/** Header clicks go ascending, descending, then back to the file's order. */
export function nextSort(sort: Sort | null, col: number): Sort | null {
  if (sort?.col !== col) return { col, dir: "asc" };
  return sort.dir === "asc" ? { col, dir: "desc" } : null;
}

/** A column's header text: its name, or "column 3" for one with none. */
export function columnLabel(name: string, col: number): string {
  return name === "" ? `column ${String(col + 1)}` : name;
}

/** The widest a column grows, in characters; longer values are cut with an ellipsis. */
export const MAX_COLUMN_CH = 48;
const MIN_COLUMN_CH = 3;

export function columnWidth(longest: number): number {
  return Math.max(MIN_COLUMN_CH, Math.min(MAX_COLUMN_CH, longest));
}

const NUMBER = /^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/;
const GROUPED = /^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;

/** A cell's number, or null when it is not one: `42`, `-3.5`, `1e6`, `1,280.00`. */
export function numberOf(text: string): number | null {
  const t = text.trim();
  if (t === "") return null;
  if (NUMBER.test(t)) return Number(t);
  if (GROUPED.test(t)) return Number(t.replace(/,/g, ""));
  return null;
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/**
 * The rows' order under `sort`: indexes into `count` rows, keyed once each by `key`. Empty
 * keys go last in both directions; ties keep the file's order.
 */
export function sortedOrder(count: number, sort: Sort | null, key: (row: number, col: number) => SortKey): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  if (!sort) return order;
  const keys = order.map((i) => key(i, sort.col));
  const sign = sort.dir === "asc" ? 1 : -1;
  order.sort((a, b) => {
    const x = keys[a] ?? null;
    const y = keys[b] ?? null;
    if (x === null || y === null) return x === y ? a - b : x === null ? 1 : -1;
    let c: number;
    if (typeof x === "number" && typeof y === "number") c = x - y;
    else if (typeof x === "number") c = -1;
    else if (typeof y === "number") c = 1;
    else c = collator.compare(x, y);
    return c === 0 ? a - b : c * sign;
  });
  return order;
}

/** One field of tab-separated text: quoted (as spreadsheets read a paste) when it holds a tab, a line break or a quote. */
function tsvField(s: string): string {
  return /[\t\n\r"]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** Rows of fields as tab-separated text, one line each, ending with a line break. */
export function toTsv(rows: Iterable<readonly string[]>): string {
  let out = "";
  for (const r of rows) out += `${r.map(tsvField).join("\t")}\n`;
  return out;
}

/** "1 row", "10,234 rows". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}
