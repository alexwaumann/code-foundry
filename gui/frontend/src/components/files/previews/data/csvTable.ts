import { delimiterFor, parseCsv } from "./csv";
import { memoByText } from "./memo";
import { columnLabel, columnWidth, numberOf, sortedOrder, toTsv, type Column, type Sort, type SortKey } from "./table";

/** A CSV or TSV file as the Table preview shows it: the first record is the header. */
export interface CsvTable {
  readonly columns: readonly Column[];
  /** The records after the header, each padded to the column count. */
  readonly rows: readonly (readonly string[])[];
  readonly delimiter: string;
  /** The file has no records at all (empty, or blank lines only). */
  readonly empty: boolean;
}

/**
 * Builds the table from a file's text. A read cut at the cap (`truncated`) loses its last
 * record unless the cut fell exactly on a record's end, so no half row shows.
 */
export function csvTable(text: string, path: string, truncated = false): CsvTable {
  const delimiter = delimiterFor(path, text);
  const parsed = parseCsv(text, delimiter);
  const records = parsed.records;
  if (truncated && (!parsed.endsClean || parsed.openQuote) && records.length > 1) records.pop();
  const header = records[0] ?? [];
  const body = records.slice(1);
  let width = header.length;
  for (const r of body) if (r.length > width) width = r.length;
  const longest = header.map((h) => h.length);
  const numeric = new Array<boolean>(width).fill(true);
  const seen = new Array<boolean>(width).fill(false);
  for (const r of body) {
    for (let c = 0; c < width; c++) {
      const v = r[c] ?? "";
      if (v.length > (longest[c] ?? 0)) longest[c] = v.length;
      if (v === "") continue;
      seen[c] = true;
      if (numeric[c] && numberOf(v) === null) numeric[c] = false;
    }
    while (r.length < width) r.push("");
  }
  const columns = Array.from({ length: width }, (_, c): Column => ({
    name: header[c] ?? "",
    numeric: seen[c] === true && numeric[c] === true,
    width: columnWidth(Math.max(longest[c] ?? 0, columnLabel(header[c] ?? "", c).length)),
  }));
  return { columns, rows: body, delimiter, empty: records.length === 0 };
}

/** A cell's sort key: its number in a numeric column, else its text; an empty cell none. */
export function csvSortKey(table: CsvTable, row: number, col: number): SortKey {
  const v = table.rows[row]?.[col] ?? "";
  if (v === "") return null;
  return table.columns[col]?.numeric ? numberOf(v) : v;
}

/** The rows' order under a sort (indexes into `rows`). */
export function csvOrder(table: CsvTable, sort: Sort | null): number[] {
  return sortedOrder(table.rows.length, sort && sort.col < table.columns.length ? sort : null, (r, c) => csvSortKey(table, r, c));
}

/** The table as tab-separated text, header first, rows in the order shown. */
export function csvTsv(table: CsvTable, sort: Sort | null): string {
  const order = csvOrder(table, sort);
  return toTsv([table.columns.map((c) => c.name), ...order.map((i) => table.rows[i] ?? [])]);
}

/** The read's table, parsed once per contents (the body, the meta and the copy share it). */
export const csvOf = memoByText((text, path, truncated) => csvTable(text, path, truncated));
