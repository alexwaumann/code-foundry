/**
 * Plugin tables in the mock daemon (docs/notes/plugin-table.md): a table's acting elements
 * as the daemon indexes them (internal/store/plugin/surface_table.go: a sortable column's
 * header is a sort, its rows click and carry buttons and menus), a sort's value checked as
 * the daemon checks it, and a sort applied to a view's table as the hello demo's Runs tab
 * does it (plugins/examples/hello/builds.go: by the column's cells, ties by the row's key,
 * both in the asked direction) or a custom view's (fuzzControl's `view:<json>`).
 */
import { Code, ConnectError } from "@connectrpc/connect";

type Node = Record<string, unknown> & { key: string };
type Dir = "asc" | "desc";

interface Column {
  key: string;
  label?: string;
  sortable?: boolean;
  sortFirst?: string;
}

interface Row {
  key: string;
  cells?: Record<string, unknown>;
  action?: unknown;
  actions?: unknown[];
  menu?: unknown;
}

interface TableShape {
  columns: Column[];
  rows?: Row[];
  groups?: { rows: Row[] }[];
  sort?: { column: string; dir: Dir };
}

/** A sortable column's header as an element: the column's key, the table, and the direction a click without one asks for. */
export interface SortElement {
  key: string;
  node: string;
  next: Dir;
}

/** The direction a click on `c`'s header asks for (pluginsdk/ui NextSort). */
function nextSort(c: Column, sort: TableShape["sort"]): Dir {
  if (sort?.column === c.key) return sort.dir === "desc" ? "asc" : "desc";
  return c.sortFirst === "desc" ? "desc" : "asc";
}

/** A table node's acting parts: its sortable columns, and each row (for its action, buttons and menu). */
export function tableParts(n: Node): { sorts: SortElement[]; rows: Row[] } {
  const t = n.table as TableShape | undefined;
  if (!t) return { sorts: [], rows: [] };
  const sorts = t.columns.filter((c) => c.sortable).map((c) => ({ key: c.key, node: n.key, next: nextSort(c, t.sort) }));
  return { sorts, rows: t.groups ? t.groups.flatMap((g) => g.rows) : (t.rows ?? []) };
}

/** A sort act's direction: the client's, or without one the header's next (the daemon's sortValue). */
export function sortValue(value: string, next: Dir): Dir {
  if (value === "") return next;
  if (value === "asc" || value === "desc") return value;
  throw new ConnectError(`a sort's value is asc or desc, not "${value}"`, Code.InvalidArgument);
}

/** A cell's sort key: a duration's ms, else its text ("—" and empty sort first). */
function cellKey(cell: unknown): number | string {
  if (cell === undefined) return "";
  if (typeof cell === "string") return cell;
  const c = cell as { value?: unknown; text?: string; spans?: { text?: string; duration?: { ms: number } }[] };
  if (c.value !== undefined) return cellKey(c.value);
  const spans = c.spans ?? [];
  const d = spans.find((s) => s.duration);
  if (d?.duration) return d.duration.ms;
  return c.text ?? spans.map((s) => s.text ?? "").join("");
}

const collator = new Intl.Collator("en", { numeric: true });

function compareKeys(a: number | string, b: number | string): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "number") return 1;
  if (typeof b === "number") return -1;
  return collator.compare(a, b);
}

/** Sorts `node`'s table in place by `column`, as the demo plugin does, and marks the sort. */
export function sortTable(node: Node, column: string, dir: Dir): void {
  const t = node.table as TableShape | undefined;
  if (!t) return;
  const by = (a: Row, b: Row) => {
    const c = compareKeys(cellKey(a.cells?.[column]), cellKey(b.cells?.[column])) || collator.compare(a.key, b.key);
    return dir === "desc" ? -c : c;
  };
  if (t.groups) for (const g of t.groups) g.rows.sort(by);
  else t.rows?.sort(by);
  t.sort = { column, dir };
}
