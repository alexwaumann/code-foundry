import { countLabel, jsonText, parseJson, type JsonError, type JsonNode } from "./json";
import { memoByText } from "./memo";
import { columnLabel, columnWidth, sortedOrder, toTsv, type Column, type Sort, type SortKey } from "./table";

/** One non-blank line of a JSON Lines file. */
export interface JsonlRecord {
  /** The line's number in the file, 1-based (blank lines count): what the gutter shows. */
  readonly line: number;
  /** The line's text, without its line break. */
  readonly raw: string;
  /** The parsed value; null when the line is not valid JSON (`error` says why). */
  readonly node: JsonNode | null;
  readonly error: JsonError | null;
  /** For an object, its value under each column (undefined: the key is missing); null for anything else. */
  readonly cells: readonly (JsonNode | undefined)[] | null;
}

export interface JsonlTable {
  /** The union of the objects' top-level keys, in the order first seen. */
  readonly columns: readonly Column[];
  readonly records: readonly JsonlRecord[];
  /** Lines that are not valid JSON. */
  readonly invalid: number;
}

/** What a cell shows, as text: a string as is, a number as written, `{2}`/`[3]` for nested values. */
export function cellText(v: JsonNode | undefined): string {
  if (v === undefined) return "";
  switch (v.t) {
    case "string":
      return v.v;
    case "number":
      return v.raw;
    case "bool":
      return String(v.v);
    case "null":
      return "null";
    default:
      return countLabel(v);
  }
}

/**
 * Builds the records from a file's text: one per non-blank line, a line that does not parse
 * kept with its error. A read cut at the cap (`truncated`) drops its last line unless the
 * cut fell on a line break.
 */
export function jsonlTable(text: string, truncated = false): JsonlTable {
  const lines = text.split("\n");
  // A final line break ends the last line; a cut read's last line is partial.
  if (lines.at(-1) === "" || truncated) lines.pop();
  const records: JsonlRecord[] = [];
  const index = new Map<string, number>();
  const names: string[] = [];
  let invalid = 0;
  lines.forEach((l, i) => {
    let raw = l.endsWith("\r") ? l.slice(0, -1) : l;
    if (i === 0 && raw.charCodeAt(0) === 0xfeff) raw = raw.slice(1);
    if (raw.trim() === "") return;
    const p = parseJson(raw);
    if (!p.ok) {
      invalid++;
      records.push({ line: i + 1, raw, node: null, error: p.error, cells: null });
      return;
    }
    if (p.value.t === "object") {
      for (const [k] of p.value.entries) {
        if (!index.has(k)) {
          index.set(k, names.length);
          names.push(k);
        }
      }
    }
    records.push({ line: i + 1, raw, node: p.value, error: null, cells: null });
  });
  const longest = names.map((n, c) => columnLabel(n, c).length);
  const numeric = names.map(() => true);
  const seen = names.map(() => false);
  const done = records.map((r): JsonlRecord => {
    if (r.node?.t !== "object") return r;
    const cells = new Array<JsonNode | undefined>(names.length);
    // A repeated key: the last one wins, as JSON.parse would have it.
    for (const [k, v] of r.node.entries) cells[index.get(k) ?? 0] = v;
    cells.forEach((v, c) => {
      if (v === undefined) return;
      seen[c] = true;
      if (v.t !== "number") numeric[c] = false;
      const len = cellText(v).length;
      if (len > (longest[c] ?? 0)) longest[c] = len;
    });
    return { ...r, cells };
  });
  const columns = names.map((name, c): Column => ({ name, numeric: seen[c] === true && numeric[c] === true, width: columnWidth(longest[c] ?? 0) }));
  return { columns, records: done, invalid };
}

/** A cell's sort key: a number's value, a string's text, other values their JSON; missing and null none. */
export function jsonlSortKey(table: JsonlTable, row: number, col: number): SortKey {
  const v = table.records[row]?.cells?.[col];
  if (v === undefined || v.t === "null") return null;
  if (v.t === "number") return Number(v.raw);
  if (v.t === "string") return v.v;
  return jsonText(v);
}

/** The records' order under a sort (indexes into `records`). */
export function jsonlOrder(table: JsonlTable, sort: Sort | null): number[] {
  return sortedOrder(table.records.length, sort && sort.col < table.columns.length ? sort : null, (r, c) => jsonlSortKey(table, r, c));
}

/**
 * The records as tab-separated text, header first, in the order shown. A nested value is
 * its JSON (a count would paste as nothing useful); a line that is not an object is its
 * text in the first column.
 */
export function jsonlTsv(table: JsonlTable, sort: Sort | null): string {
  const order = jsonlOrder(table, sort);
  const field = (v: JsonNode | undefined) => (v === undefined ? "" : v.t === "object" || v.t === "array" ? jsonText(v) : cellText(v));
  return toTsv([
    table.columns.map((c) => c.name),
    ...order.map((i) => {
      const r = table.records[i];
      if (!r) return [];
      return r.cells ? Array.from(r.cells, field) : [r.raw];
    }),
  ]);
}

/** The read's records, parsed once per contents (the body, the meta and the copy share them). */
export const jsonlOf = memoByText((text, _path, truncated) => jsonlTable(text, truncated));
