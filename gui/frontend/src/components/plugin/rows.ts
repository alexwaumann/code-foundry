/**
 * A list's interactive rows (docs/notes/plugin-list-rows.md): what the user did to them
 * and the host shows before the plugin's next view (a tick, a new place, a new title), and
 * the arithmetic of moving a row by drag or by key. Pure: ListNode holds the state.
 */
import type { Row } from "@/api/plugin";

/** One change the user made to a row, sent to the plugin as a row act of the same kind. */
export type RowChange = { kind: "check"; key: string; checked: boolean } | { kind: "move"; key: string; after: string } | { kind: "edit"; key: string; title: string };

/**
 * A change shown before the plugin's view has it: from the user's act until the plugin
 * refuses it, or, once it took it (`answered`, the view version then `at`), until a view
 * shows it or a newer view comes (whatever it shows: the plugin decided), or at most
 * CHOICE_HOLD_MS after the answer.
 */
export interface PendingChange {
  id: number;
  change: RowChange;
  answered: boolean;
  at: number;
}

/** The keys of rows in order. */
export function keysOf(rows: readonly Row[]): string[] {
  return rows.map((r) => r.key);
}

/** The key of the row above `key` in `keys`, "" when it is first (or not there). */
export function afterOf(keys: readonly string[], key: string): string {
  const i = keys.indexOf(key);
  return i > 0 ? (keys[i - 1] ?? "") : "";
}

/** `keys` with `key` moved to just under `after` ("" for the top); unchanged when either is not there. */
export function moveKeys(keys: readonly string[], key: string, after: string): string[] {
  if (!keys.includes(key) || key === after || (after !== "" && !keys.includes(after))) return [...keys];
  const rest = keys.filter((k) => k !== key);
  const at = after === "" ? 0 : rest.indexOf(after) + 1;
  return [...rest.slice(0, at), key, ...rest.slice(at)];
}

/** Rows with the changes applied in order: ticks, titles, places. A change to a row not there does nothing. */
export function applyChanges(rows: readonly Row[], changes: readonly RowChange[]): readonly Row[] {
  if (changes.length === 0) return rows;
  let out = [...rows];
  for (const c of changes) {
    const i = out.findIndex((r) => r.key === c.key);
    const row = out[i];
    if (!row) continue;
    if (c.kind === "check") out[i] = { ...row, checked: c.checked };
    else if (c.kind === "edit") out[i] = { ...row, title: c.title };
    else {
      const order = moveKeys(keysOf(out), c.key, c.after);
      const byKey = new Map(out.map((r) => [r.key, r]));
      out = order.map((k) => byKey.get(k)).filter((r): r is Row => r !== undefined);
    }
  }
  return out;
}

/** Whether the plugin's rows show the change already (a row that is gone shows nothing to change). */
export function shows(rows: readonly Row[], c: RowChange): boolean {
  const row = rows.find((r) => r.key === c.key);
  if (!row) return true;
  if (c.kind === "check") return (row.checked ?? false) === c.checked;
  if (c.kind === "edit") return row.title === c.title;
  return afterOf(keysOf(rows), c.key) === c.after;
}

/**
 * The changes still shown against the plugin's rows at view `version`: an unanswered one,
 * and an answered one the rows do not show yet while no newer view came.
 */
export function settle(pending: readonly PendingChange[], rows: readonly Row[], version: number): readonly PendingChange[] {
  const next = pending.filter((p) => !p.answered || (version <= p.at && !shows(rows, p.change)));
  return next.length === pending.length ? pending : next;
}

/** `pending` with `change` added, replacing one of the same kind on the same row (a later tick or title or place wins). */
export function addPending(pending: readonly PendingChange[], change: RowChange, id: number): PendingChange[] {
  return [...pending.filter((p) => p.change.kind !== change.kind || p.change.key !== change.key), { id, change, answered: false, at: 0 }];
}

/**
 * The text an edit commits: the trimmed text, or null (nothing to send) when it is empty
 * or the title unchanged.
 */
export function editCommit(title: string, text: string): string | null {
  const t = text.trim();
  return t === "" || t === title.trim() ? null : t;
}

/**
 * Where alt+↑ (dir -1) or alt+↓ (dir 1) moves `key`: its new upper neighbour, or null at
 * an end (nothing moves).
 */
export function keyMove(keys: readonly string[], key: string, dir: -1 | 1): string | null {
  const i = keys.indexOf(key);
  if (i < 0) return null;
  if (dir < 0) return i === 0 ? null : (keys[i - 2] ?? "");
  return i >= keys.length - 1 ? null : (keys[i + 1] ?? null);
}

/** One drawn row: its key and its box's top and bottom on screen. */
export interface RowBox {
  key: string;
  top: number;
  bottom: number;
}

/**
 * Where a row dragged with the pointer at `y` lands, from the rows drawn (a virtualized
 * list draws those near the viewport, and the pointer is over them): the gap above the
 * first drawn row whose middle is under the pointer, else under the last drawn one. It
 * returns the gap's upper row in the list's order (`keys`; "" for the top) and its line's
 * y on screen; `after` is null when dropping there leaves `key` where it is.
 */
export function dropAt(keys: readonly string[], boxes: readonly RowBox[], key: string, y: number): { after: string | null; lineY: number } | null {
  const drawn = [...boxes].sort((a, b) => a.top - b.top);
  const last = drawn[drawn.length - 1];
  if (!last) return null;
  const below = drawn.find((b) => y < (b.top + b.bottom) / 2);
  const upper = below ? afterOf(keys, below.key) : last.key;
  const lineY = below ? below.top : last.bottom;
  const same = upper === key || upper === afterOf(keys, key);
  return { after: same ? null : upper, lineY };
}

/**
 * How far to scroll a box per frame while dragging near its edges: up to `max` px, more
 * the closer the pointer is to (or past) the edge, within `zone` px of it; 0 elsewhere.
 */
export function edgeScroll(y: number, top: number, bottom: number, zone = 40, max = 14): number {
  if (bottom - top < zone * 2) return 0;
  if (y < top + zone) return -Math.ceil(max * Math.min(1, (top + zone - y) / zone));
  if (y > bottom - zone) return Math.ceil(max * Math.min(1, (y - (bottom - zone)) / zone));
  return 0;
}
