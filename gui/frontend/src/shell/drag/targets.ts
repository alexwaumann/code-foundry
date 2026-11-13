/**
 * Where a dragged tab or pane would land (docs/notes/shell-model.md, "Structure"): a pure
 * function from the pointer and the drawn frame to one drop target. Everything is in layout px
 * from the pane grid's top left, as `Frame` is (shell/geometry). The drag layer
 * (components/shell/ShellDnd.tsx) measures the strips, calls this on every move and turns the
 * target into one `tab.move` or `pane.move` on release (drop.ts).
 *
 * Zones, in order of precedence where they overlap:
 *   1. The grid's outer edges: a band `OUTER_IN` px inside the grid and `OUTER_OUT` px outside
 *      it, along each side. In a corner the nearer side wins (left/right on a tie).
 *   2. A pane's strip (its top `stripHeight` px): a place in that strip, by the tabs' centres.
 *   3. A pane's body: its four edges, each a band of `EDGE_SHARE` (a third) of the body (at
 *      most `EDGE_MAX`), the nearest edge winning; the middle third is the pane itself (join its
 *      strip at the end). A body too narrow for a split has no left and right edges, one too short no top
 *      and bottom edges.
 *   4. Anything else (a gutter, outside the bands): no target.
 * See docs/notes/shell-14-drag.md.
 */
import type { Frame, Rect } from "@/shell/geometry/types";

export type Edge = "left" | "right" | "top" | "bottom";

/**
 * What is dragged: one tab (from its pane), a whole pane by its strip, or a sidebar row's thread
 * whose tab is not open in the space (docs/notes/shell-16-sidebar.md; an open one drags as its tab).
 */
export type DragSource = { kind: "tab"; tab: string; pane: string } | { kind: "pane"; pane: string } | { kind: "thread"; thread: string };

/** Where it lands. */
export type DropTarget =
  /** A place in a pane's strip, before the tab now at `index` (its length: the end). */
  | { kind: "strip"; pane: string; index: number }
  /** A pane's body away from its edges: the end of that pane's strip. */
  | { kind: "pane"; pane: string }
  /** An edge of a pane: a new pane there, splitting it. */
  | { kind: "edge"; pane: string; edge: Edge }
  /** An edge of the whole grid: a full-height column or full-width row there. */
  | { kind: "outer"; edge: Edge };

/** A tab as the strip draws it: its horizontal extent (layout px from the grid's left) and its name. */
export interface StripTab {
  id: string;
  x: number;
  w: number;
  title: string;
}

/** What hit-testing reads: the drawn frame and every strip's tabs. */
export interface DragScene {
  frame: Frame;
  /** Each pane's tabs in strip order. A pane missing here counts as one with no tabs. */
  strips: Readonly<Record<string, readonly StripTab[]>>;
  /** The height of a pane's strip. */
  stripHeight: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The outer band: this far inside the grid's edge, and this far outside it. */
export const OUTER_IN = 10;
export const OUTER_OUT = 24;
/**
 * A pane's edge zone: this share of its body, at most this many px. A third each way leaves the
 * middle third (at least) for "add to this pane" (docs/notes/shell-25a-test-feedback.md).
 */
export const EDGE_SHARE = 1 / 3;
export const EDGE_MAX = { w: 320, h: 260 };
/** The least body width that has left and right edges, and height that has top and bottom ones. */
export const EDGE_MIN = { w: 240, h: 160 };

function inside(r: Rect, p: Point): boolean {
  return p.x >= r.x && p.x < r.x + r.w && p.y >= r.y && p.y < r.y + r.h;
}

function tabsOf(scene: DragScene, pane: string): readonly StripTab[] {
  return Object.hasOwn(scene.strips, pane) ? (scene.strips[pane] ?? []) : [];
}

/** The place in a strip the pointer's x points at: before the first tab whose centre is right of it. */
export function stripIndex(tabs: readonly StripTab[], x: number): number {
  let i = 0;
  for (const t of tabs) {
    if (x > t.x + t.w / 2) i++;
  }
  return i;
}

/** The side of the grid the pointer is on the outer band of, or null. */
export function outerEdge(frame: Frame, p: Point): Edge | null {
  const { w, h } = frame;
  if (p.x < -OUTER_OUT || p.x > w + OUTER_OUT || p.y < -OUTER_OUT || p.y > h + OUTER_OUT) return null;
  const dist: [Edge, number][] = [
    ["left", p.x],
    ["right", w - p.x],
    ["top", p.y],
    ["bottom", h - p.y],
  ];
  let best: [Edge, number] | null = null;
  for (const d of dist) {
    if (d[1] < OUTER_IN && (!best || d[1] < best[1])) best = d;
  }
  return best ? best[0] : null;
}

/** The edge zone of a pane's body the pointer is in, or null in its middle. */
export function bodyEdge(body: Rect, p: Point): Edge | null {
  const tx = Math.min(body.w * EDGE_SHARE, EDGE_MAX.w);
  const ty = Math.min(body.h * EDGE_SHARE, EDGE_MAX.h);
  const near: [Edge, number][] = [];
  if (body.w >= EDGE_MIN.w) near.push(["left", (p.x - body.x) / tx], ["right", (body.x + body.w - p.x) / tx]);
  if (body.h >= EDGE_MIN.h) near.push(["top", (p.y - body.y) / ty], ["bottom", (body.y + body.h - p.y) / ty]);
  let best: [Edge, number] | null = null;
  for (const n of near) {
    if (n[1] < 1 && (!best || n[1] < best[1])) best = n;
  }
  return best ? best[0] : null;
}

/** The raw target under the pointer, before asking whether the drop would do anything. */
function zoneAt(scene: DragScene, p: Point): DropTarget | null {
  const outer = outerEdge(scene.frame, p);
  if (outer) return { kind: "outer", edge: outer };
  for (const [pane, r] of Object.entries(scene.frame.rects)) {
    if (!inside(r, p)) continue;
    // A rail (a folded pane) is one target as a whole: a tab joins the end of its tabs.
    if (r.rail) return { kind: "pane", pane };
    const strip = Math.min(scene.stripHeight, r.h);
    if (p.y < r.y + strip)
      return {
        kind: "strip",
        pane,
        index: stripIndex(tabsOf(scene, pane), p.x),
      };
    const body = { x: r.x, y: r.y + strip, w: r.w, h: r.h - strip };
    const edge = bodyEdge(body, p);
    return edge ? { kind: "edge", pane, edge } : { kind: "pane", pane };
  }
  return null;
}

/**
 * Whether dropping there would change anything a user can see a reason for: a pane never drops
 * onto itself, a pane's only tab never splits its own pane or joins its own strip's end, and the
 * grid's only pane (or the only tab of it) has no outer edge to move to. A reorder onto the
 * tab's own place stays a target (the bar shows where it is) and moves nothing (drop.ts).
 */
function allowed(scene: DragScene, source: DragSource, t: DropTarget): boolean {
  const panes = Object.keys(scene.frame.rects);
  // A thread from the sidebar comes from no pane: every place takes it.
  if (source.kind === "thread") return true;
  if (source.kind === "pane") {
    if (t.kind === "outer") return panes.length > 1;
    return t.pane !== source.pane;
  }
  const own = tabsOf(scene, source.pane).length;
  if (t.kind === "outer") return panes.length > 1 || own > 1;
  if (t.pane !== source.pane) return true;
  if (t.kind === "strip") return true;
  if (t.kind === "edge") return own > 1;
  return false;
}

/** The drop target for `source` with the pointer at `p`, or null where a drop does nothing. */
export function dropTarget(scene: DragScene, source: DragSource, p: Point): DropTarget | null {
  const t = zoneAt(scene, p);
  return t && allowed(scene, source, t) ? t : null;
}

/** The insertion bar of a strip target: x, top and height in layout px. */
export function insertionBar(scene: DragScene, pane: string, index: number): { x: number; y: number; h: number } | null {
  const r = scene.frame.rects[pane];
  if (!r) return null;
  const tabs = tabsOf(scene, pane);
  const h = Math.min(28, scene.stripHeight - 8);
  const y = r.y + (Math.min(scene.stripHeight, r.h) - h) / 2;
  const before = tabs.at(index);
  const last = tabs.at(-1);
  const x = before ? before.x - 2 : last ? last.x + last.w + 1 : r.x + 8;
  return { x, y, h };
}

/** Whether two targets are the same (the drag layer redraws and announces only on a change). */
export function sameTarget(a: DropTarget | null, b: DropTarget | null): boolean {
  if (a === b) return true;
  if (!a || !b || a.kind !== b.kind) return false;
  switch (a.kind) {
    case "outer":
      return a.edge === (b as typeof a).edge;
    case "strip":
      return a.pane === (b as typeof a).pane && a.index === (b as typeof a).index;
    case "edge":
      return a.pane === (b as typeof a).pane && a.edge === (b as typeof a).edge;
    case "pane":
      return a.pane === (b as typeof a).pane;
  }
}
