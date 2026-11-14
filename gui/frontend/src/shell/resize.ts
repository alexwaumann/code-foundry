/**
 * Dragging a gutter (components/shell/Gutter.tsx): the two kids beside it trade length, each kept
 * at its minimum (a folded or collapsed pane at a rail's thickness), and the split's other kids
 * keep theirs. It never folds a pane. A drag starts from what is drawn: when the split is not
 * drawn at its stored proportions (a kid held at its minimum), its open kids' sizes are first
 * taken from their drawn lengths, so the gutter does not jump when it is grabbed. Pure; the drag
 * previews the sizes this gives and commits them with pane.resize. The cursor says which way it
 * can still go (gutterReach, gutterCursor). See docs/notes/shell-11-pane-grid.md and
 * docs/notes/shell-25d-collapse.md.
 */
import { minimumOf } from "./geometry/rects";
import { panesOf, type Frame, type GeoNode, type GeoSplit, type Rect } from "./geometry/types";

/** The split with this id in a tree. */
export function findSplit(root: GeoNode | null, id: string): GeoSplit | null {
  if (!root || root.t === "pane") return null;
  if (root.id === id) return root;
  for (const k of root.kids) {
    const hit = findSplit(k, id);
    if (hit) return hit;
  }
  return null;
}

/** The box around a node's drawn panes. */
export function extentOf(node: GeoNode, frame: Frame): Rect | null {
  const rects = panesOf(node).flatMap((p) => frame.rects[p.id] ?? []);
  if (rects.length === 0) return null;
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  return { x, y, w: Math.max(...rects.map((r) => r.x + r.w)) - x, h: Math.max(...rects.map((r) => r.y + r.h)) - y };
}

export interface GutterDrag {
  split: string;
  /** The gutter is after kid `i`. */
  i: number;
  row: boolean;
  /** The split's sizes when the drag started, as drawn (see drawnSizes). */
  sizes: readonly number[];
  /** The two kids' drawn lengths along the split when it started. */
  lens: readonly [number, number];
  /** Their minimum lengths. */
  mins: readonly [number, number];
}

/** The panes the frame draws as rails (folded or collapsed). */
function railsOf(frame: Frame): Set<string> {
  return new Set(Object.entries(frame.rects).flatMap(([id, r]) => (r.rail ? [id] : [])));
}

/** Whether every pane under n is drawn as a rail. */
function allRail(n: GeoNode, rails: ReadonlySet<string>): boolean {
  return panesOf(n).every((p) => rails.has(p.id));
}

/**
 * The split's sizes as it is drawn: its stored sizes when the open kids (not all rails) are drawn
 * at their stored proportions (to the rounding px), else the open kids' drawn lengths scaled to
 * the share they had together; a kid that is all rails keeps its stored size either way.
 */
function drawnSizes(s: GeoSplit, frame: Frame, rails: ReadonlySet<string>): readonly number[] {
  const row = s.dir === "row";
  const open = s.kids.map((k) => !allRail(k, rails));
  const lens = s.kids.map((k) => {
    const e = extentOf(k, frame);
    return e ? (row ? e.w : e.h) : 0;
  });
  let share = 0;
  let drawn = 0;
  s.kids.forEach((_, j) => {
    if (!open[j]) return;
    share += s.sizes[j] ?? 0;
    drawn += lens[j] ?? 0;
  });
  if (!(share > 0) || !(drawn > 0)) return s.sizes;
  const asStored = s.kids.every((_, j) => !open[j] || Math.abs((drawn * (s.sizes[j] ?? 0)) / share - (lens[j] ?? 0)) <= 1);
  if (asStored) return s.sizes;
  return s.sizes.map((size, j) => (open[j] ? (share * (lens[j] ?? 0)) / drawn : size));
}

/** What a drag needs to know at its start; null when the gutter's split is not in the frame. */
export function startDrag(root: GeoNode | null, frame: Frame, split: string, i: number): GutterDrag | null {
  const s = findSplit(root, split);
  const a = s?.kids[i];
  const b = s?.kids[i + 1];
  if (!s || !a || !b) return null;
  const ea = extentOf(a, frame);
  const eb = extentOf(b, frame);
  if (!ea || !eb) return null;
  const row = s.dir === "row";
  const along = (r: { w: number; h: number }) => (row ? r.w : r.h);
  const rails = railsOf(frame);
  return {
    split,
    i,
    row,
    sizes: drawnSizes(s, frame, rails),
    lens: [along(ea), along(eb)],
    mins: [along(minimumOf(a, rails)), along(minimumOf(b, rails))],
  };
}

/** Which ways a gutter can still move from where a drag `delta` px along took it: towards its first kid (`back`) or away (`forward`). */
export interface GutterReach {
  back: boolean;
  forward: boolean;
}

/** The first kid's length after moving `delta`, each kid kept at its minimum; its length now when their minimums do not fit. */
function firstLength(d: GutterDrag, delta: number): number {
  const [la, lb] = d.lens;
  const [ma, mb] = d.mins;
  const total = la + lb;
  return ma + mb > total ? la : Math.min(total - mb, Math.max(ma, la + delta));
}

/** Which ways the gutter can move after `delta` (0: where the drag started); neither when the two kids' minimums take all they have. */
export function gutterReach(d: GutterDrag, delta = 0): GutterReach {
  const [la, lb] = d.lens;
  const [ma, mb] = d.mins;
  const total = la + lb;
  if (ma + mb > total - 0.5) return { back: false, forward: false };
  const a = firstLength(d, delta);
  return { back: a > ma + 0.5, forward: total - a > mb + 0.5 };
}

/**
 * The cursor of a gutter (docs/notes/shell-model.md, "Dividers"): the resize cursor both ways, the
 * one-way resize cursor pointing the way it can still go, or not-allowed when it cannot move (a
 * `fixed` gutter, beside a side that is all rails, never can).
 */
export function gutterCursor(row: boolean, reach: GutterReach | null): string {
  if (!reach || (!reach.back && !reach.forward)) return "not-allowed";
  if (reach.back && reach.forward) return row ? "col-resize" : "row-resize";
  if (reach.back) return row ? "w-resize" : "n-resize";
  return row ? "e-resize" : "s-resize";
}

/**
 * The split's sizes after the gutter moved `delta` layout px (right or down is positive). The two
 * kids share what they had between them; neither goes below its minimum (when their minimums do
 * not fit, the gutter stays where it was).
 */
export function dragSizes(d: GutterDrag, delta: number): number[] {
  const [la, lb] = d.lens;
  const total = la + lb;
  const a = firstLength(d, delta);
  const share = (d.sizes[d.i] ?? 0) + (d.sizes[d.i + 1] ?? 0);
  const out = [...d.sizes];
  out[d.i] = total > 0 ? (share * a) / total : (d.sizes[d.i] ?? 0);
  out[d.i + 1] = share - (out[d.i] ?? 0);
  return out;
}

/** How far one arrow key moves a gutter (layout px); Shift moves it four times as far. */
export const GUTTER_STEP = 16;

/**
 * How far a key on a focused gutter moves it (layout px, right or down positive), as the side
 * panel's divider took them: Left or Up towards the first kid, Right or Down away from it (both
 * pairs in either direction), GUTTER_STEP (Shift: four times that); Home and End to the bounds
 * (dragSizes keeps each kid at its minimum). Null for any other key.
 */
export function gutterKeyDelta(key: string, shift: boolean): number | null {
  const step = (shift ? 4 : 1) * GUTTER_STEP;
  if (key === "ArrowLeft" || key === "ArrowUp") return -step;
  if (key === "ArrowRight" || key === "ArrowDown") return step;
  if (key === "Home") return -Infinity;
  if (key === "End") return Infinity;
  return null;
}

/** A gutter's double-click: the two kids beside it share what they have between them evenly (each kept at its minimum). */
export function evenSizes(d: GutterDrag): number[] {
  return dragSizes(d, (d.lens[1] - d.lens[0]) / 2);
}

/** A tree with one split's sizes replaced (the drag's preview); the same tree when it has no such split. */
export function withSizes(root: GeoNode | null, split: string, sizes: readonly number[]): GeoNode | null {
  if (!root || root.t === "pane") return root;
  if (root.id === split) return { ...root, sizes };
  const kids = root.kids.map((k) => withSizes(k, split, sizes) ?? k);
  return kids.some((k, i) => k !== root.kids[i]) ? { ...root, kids } : root;
}

/** Sizes as pane.resize takes them: comma separated, enough digits to keep the drawn px. */
export function sizesArg(sizes: readonly number[]): string {
  return sizes.map((n) => String(Math.round(n * 1e6) / 1e6)).join(",");
}
