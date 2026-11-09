/**
 * A list's interactive rows in the mock daemon (docs/notes/plugin-list-rows.md): the row
 * acts the daemon shapes from the view (internal/store/plugin/list_rows.go: check, move,
 * add, edit on a list node, the value checked as it checks it), the hello demo's Todo tab
 * state (plugins/examples/hello/todo.go) patched into its captured view, and the same
 * changes applied to a custom view's lists (fuzzControl's `view:<json>`), so a drag or a
 * tick there shows.
 */
import { Code, ConnectError } from "@connectrpc/connect";

type Node = Record<string, unknown> & { key: string };

export interface ListRow {
  key: string;
  title: string;
  checked?: boolean;
  editable?: boolean;
  [k: string]: unknown;
}

interface ListShape {
  rows?: ListRow[];
  checkable?: boolean;
  reorderable?: boolean;
  add?: { placeholder?: string };
}

/** A row act as the daemon shapes it: its kind (also its action), the row's (or list's) key, the list and the value as the plugin gets it. */
export interface RowOp {
  kind: "check" | "move" | "add" | "edit";
  key: string;
  node: string;
  value: boolean | string;
}

const OPS = ["check", "move", "add", "edit"] as const;
const MAX_TEXT = 200;

function bad(msg: string): ConnectError {
  return new ConnectError(msg, Code.InvalidArgument);
}

/** Every list node of a view (not a master-detail's list), with its key. */
function listsOf(view: Record<string, unknown>, childLists: (n: Node) => Node[][], viewLists: (v: Record<string, unknown>) => Node[][]): { key: string; list: ListShape }[] {
  const out: { key: string; list: ListShape }[] = [];
  const walk = (nodes: Node[]) => {
    for (const n of nodes) {
      const list: ListShape | undefined = n.list as ListShape | undefined;
      if (list) out.push({ key: n.key, list });
      for (const c of childLists(n)) walk(c);
    }
  };
  for (const l of viewLists(view)) walk(l);
  return out;
}

/**
 * The row act `action` on `key` in `view`, as the daemon finds and checks it; undefined
 * when `action` is no row act (the act is an element's). Throws InvalidArgument for a row
 * without that act or a bad value.
 */
export function rowOpOf(view: Record<string, unknown>, key: string, action: string, value: string | undefined, childLists: (n: Node) => Node[][], viewLists: (v: Record<string, unknown>) => Node[][]): RowOp | undefined {
  const kind = OPS.find((k) => k === action);
  if (!kind || !key) return undefined;
  for (const { key: node, list } of listsOf(view, childLists, viewLists)) {
    const rows = list.rows ?? [];
    const row = rows.find((r) => r.key === key);
    const has = kind === "add" ? node === key && list.add !== undefined : row !== undefined && (kind === "check" ? list.checkable : kind === "move" ? list.reorderable : row.editable) === true;
    if (!has) continue;
    if (value === undefined) throw bad(`a ${kind} act needs a value`);
    if (kind === "check") {
      if (value !== "true" && value !== "false") throw bad(`a check's value is true or false, not "${value}"`);
      return { kind, key, node, value: value === "true" };
    }
    if (kind === "move") {
      if (value === key || (value !== "" && !rows.some((r) => r.key === value))) throw bad(`a move's value is "" (first) or the key of another row of list "${node}", not "${value}"`);
      return { kind, key, node, value };
    }
    const t = value.trim();
    if (t === "") throw bad("the text is empty");
    if (/[\r\n]/.test(t)) throw bad("the text is one line");
    // Characters as the daemon counts them (code points).
    if (Array.from(t).length > MAX_TEXT) throw bad(`the text is over ${String(MAX_TEXT)} characters`);
    return { kind, key, node, value: t };
  }
  return undefined;
}

/** Applies a row act to rows (in place of a plugin): a tick, a new place, a new title, a new row last. */
export function applyRowOp(rows: ListRow[], op: RowOp, newKey: () => string): ListRow[] {
  const i = rows.findIndex((r) => r.key === op.key);
  if (op.kind === "add") return [...rows, { key: newKey(), title: String(op.value) }];
  const row = rows[i];
  if (!row) return rows;
  if (op.kind === "check") return rows.map((r) => (r.key === op.key ? { ...r, checked: op.value === true } : r));
  if (op.kind === "edit") return rows.map((r) => (r.key === op.key ? { ...r, title: String(op.value) } : r));
  const rest = rows.filter((r) => r.key !== op.key);
  const at = op.value === "" ? 0 : rest.findIndex((r) => r.key === op.value) + 1;
  return [...rest.slice(0, at), row, ...rest.slice(at)];
}

/** A row act on a custom view: the list's rows changed in place (an add's row keyed `<list>-new-N`). */
export function applyToCustom(view: Record<string, unknown>, op: RowOp, childLists: (n: Node) => Node[][], viewLists: (v: Record<string, unknown>) => Node[][]): void {
  const l = listsOf(view, childLists, viewLists).find((x) => x.key === op.node);
  if (!l) return;
  let n = 0;
  l.list.rows = applyRowOp(l.list.rows ?? [], op, () => `${op.node}-new-${String((n += 1) + (l.list.rows?.length ?? 0))}`);
}

/**
 * The hello demo's Todo tab (plugins/examples/hello/todo.go): the tasks in order, open and
 * done, starting from the captured view's rows. A tick moves a task to the top of Done, an
 * untick to the end of the open ones; an add lands last of the open ones; a title another
 * task has is refused (Aborted, as the plugin's refusal).
 */
export class TodoState {
  private items: ListRow[] | null = null;
  private next = 8;

  private init(nodes: Node[], find: (nodes: Node[], key: string) => Node | undefined): ListRow[] {
    if (!this.items) {
      const open = ((find(nodes, "todo-open")?.list as ListShape | undefined)?.rows ?? []).map((r) => ({ ...r }));
      const done = ((find(nodes, "todo-done")?.list as ListShape | undefined)?.rows ?? []).map((r) => ({ ...r }));
      this.items = [...open, ...done];
    }
    return this.items;
  }

  /** The plugin's surface/act for a row act of the Todo lists; throws its refusal. */
  act(op: RowOp, nodes: Node[], find: (nodes: Node[], key: string) => Node | undefined): void {
    const items = this.init(nodes, find);
    const taken = (title: string, except: string) => {
      if (items.some((it) => it.key !== except && it.title.toLowerCase() === title.toLowerCase())) throw new ConnectError(`plugin refused: "${title}" is already on the list`, Code.Aborted);
    };
    const firstDone = () => {
      const i = items.findIndex((it) => it.checked === true);
      return i < 0 ? items.length : i;
    };
    const i = items.findIndex((it) => it.key === op.key);
    if (op.kind === "add") {
      taken(String(op.value), "");
      items.splice(firstDone(), 0, { key: `todo-${String(this.next++)}`, title: String(op.value), editable: true });
      return;
    }
    const it = items[i];
    if (!it) throw new ConnectError(`plugin refused: no task "${op.key}"`, Code.Aborted);
    if (op.kind === "edit") {
      taken(String(op.value), op.key);
      it.title = String(op.value);
    } else if (op.kind === "check") {
      items.splice(i, 1);
      it.checked = op.value === true;
      items.splice(firstDone(), 0, it);
    } else {
      items.splice(i, 1);
      const at = op.value === "" ? 0 : items.findIndex((x) => x.key === op.value) + 1;
      items.splice(at, 0, it);
    }
  }

  /** The captured Todo view's nodes with the tasks as they are now. */
  patch(nodes: Node[], find: (nodes: Node[], key: string) => Node | undefined): void {
    if (!this.items) return;
    const open = this.items.filter((it) => it.checked !== true).map((it) => ({ ...it }));
    const done = this.items.filter((it) => it.checked === true).map((it) => ({ ...it }));
    for (const r of open) delete r.checked;
    const o = find(nodes, "todo-open")?.list as ListShape | undefined;
    if (o) o.rows = open;
    const d = find(nodes, "todo-done")?.list as ListShape | undefined;
    if (d) d.rows = done;
    const sec = find(nodes, "todo-done-sec")?.section as { meta?: unknown } | undefined;
    if (sec) sec.meta = String(done.length);
    const intro = find(nodes, "todo-intro")?.text as { content?: unknown } | undefined;
    if (intro && typeof intro.content === "string") intro.content = intro.content.replace(/^\d+ of \d+ done\./, `${String(done.length)} of ${String(this.items.length)} done.`);
  }
}
