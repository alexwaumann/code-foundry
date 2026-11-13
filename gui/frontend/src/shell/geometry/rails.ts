/**
 * Which panes fold to rails when the window cannot keep every pane at its minimum
 * (docs/notes/shell-model.md, "Small windows"). Derived per frame from the area: nothing here
 * changes the stored layout, and computing again on a larger area unfolds what now fits.
 *
 * Order: panes without a thread tab first, then panes with one; within each, the least recently
 * focused first (a pane whose tabs were never focused before any that were), and among equals the
 * later pane in layout order first. The focused pane and the pane holding the focused thread's
 * tab never fold. Panes fold in that order until the tree fits, then the folded ones are tried
 * again in reverse order and each one that can unfolds (`foldRails`). An open pane is drawn
 * smaller than its minimum only when it is one that never folds and every other pane is folded.
 * See docs/notes/shell-9-geometry.md and docs/notes/shell-25a-test-feedback.md.
 */
import { frameRects, minimumOf, paneMinimum, type MinimumOf } from "./rects";
import { activeTab, panesOf, type Frame, type GeoNode, type GeoPane, type Size } from "./types";

export interface RailsInput {
  root: GeoNode | null;
  /** The pane area, in layout px. */
  w: number;
  h: number;
  /** The space's focused pane. */
  focus?: string;
  /** Tab ids, most recently focused first (the space's `mru`). */
  mru?: readonly string[];
  minimum?: MinimumOf;
}

/** The panes that never fold: the focused one and the one holding the focused thread's tab. */
export function unfoldable(root: GeoNode | null, focus: string | undefined): Set<string> {
  const keep = new Set<string>();
  const panes = panesOf(root);
  const focused = panes.find((p) => p.id === focus);
  if (!focused) return keep;
  keep.add(focused.id);
  const thread = activeTab(focused)?.thread;
  if (thread) {
    const home = panes.find((p) => (p.tabs ?? []).some((t) => t.kind === "thread" && t.thread === thread));
    if (home) keep.add(home.id);
  }
  return keep;
}

/** The panes in the order they fold, the unfoldable ones left out. */
export function foldOrder(root: GeoNode | null, focus?: string, mru: readonly string[] = []): string[] {
  const keep = unfoldable(root, focus);
  const recency = new Map<string, number>();
  mru.forEach((id, i) => {
    if (!recency.has(id)) recency.set(id, i);
  });
  const age = (p: GeoPane): number =>
    Math.min(Infinity, ...(p.tabs ?? []).map((t) => recency.get(t.id) ?? Infinity));
  const hasThread = (p: GeoPane): number => ((p.tabs ?? []).some((t) => t.kind === "thread") ? 1 : 0);
  return panesOf(root)
    .map((p, index) => ({ p, index, age: age(p), thread: hasThread(p) }))
    .filter(({ p }) => !keep.has(p.id))
    .sort((a, b) => a.thread - b.thread || cmpAge(b.age, a.age) || b.index - a.index)
    .map(({ p }) => p.id);
}

/** Compares two mru positions, Infinity (never focused) equal to itself. */
function cmpAge(a: number, b: number): number {
  return a === b ? 0 : a < b ? -1 : 1;
}

/** How far a minimum size runs past the area in each direction (0 where it fits). */
function excess(m: Size, w: number, h: number): Size {
  return { w: Math.max(0, m.w - w), h: Math.max(0, m.h - h) };
}

/**
 * The panes to draw as rails in this area. Every pane that may fold folds in `foldOrder` until the
 * tree fits (a fold is not required to help on its own: a column only narrows once all of its
 * panes fold, docs/notes/shell-25a-test-feedback.md). Then the folded panes are tried again in
 * reverse order. While the tree fits, one unfolds when the tree still fits. When even the panes
 * that never fold cannot keep their minimums, one unfolds only when that runs no further past the
 * area and every open pane that may fold is still drawn at its minimum: the panes that never fold
 * are the only ones ever drawn smaller.
 */
export function foldRails({ root, w, h, focus, mru, minimum = paneMinimum }: RailsInput): Set<string> {
  const rails = new Set<string>();
  const fits = (s: Size) => s.w <= w && s.h <= h;
  if (fits(minimumOf(root, rails, minimum))) return rails;
  const folded: string[] = [];
  for (const id of foldOrder(root, focus, mru)) {
    rails.add(id);
    folded.push(id);
    if (fits(minimumOf(root, rails, minimum))) break;
  }
  const keep = unfoldable(root, focus);
  // Short of room: unfolding must not run further past the area, nor draw a pane that may fold short.
  const noWorse = (before: Size, after: Size): boolean => {
    const b = excess(before, w, h);
    const a = excess(after, w, h);
    return a.w <= b.w && a.h <= b.h && foldableAtMinimums(root, w, h, rails, keep, minimum);
  };
  for (const id of folded.reverse()) {
    const before = minimumOf(root, rails, minimum);
    rails.delete(id);
    const after = minimumOf(root, rails, minimum);
    if (fits(before) ? fits(after) : noWorse(before, after)) continue;
    rails.add(id);
  }
  return rails;
}

/** Whether every open pane outside `keep` is drawn at least at its minimum with these rails. */
function foldableAtMinimums(
  root: GeoNode | null,
  w: number,
  h: number,
  rails: ReadonlySet<string>,
  keep: ReadonlySet<string>,
  minimum: MinimumOf,
): boolean {
  const frame = frameRects(root, w, h, rails, minimum);
  return panesOf(root).every((p) => {
    if (rails.has(p.id) || keep.has(p.id)) return true;
    const r = frame.rects[p.id];
    const m = minimum(p);
    return !!r && r.w >= m.w - 0.5 && r.h >= m.h - 0.5;
  });
}

/** The frame the window draws: rails folded for this area, then the rectangles. */
export function shellFrame(input: RailsInput): Frame {
  return frameRects(input.root, input.w, input.h, foldRails(input), input.minimum);
}
