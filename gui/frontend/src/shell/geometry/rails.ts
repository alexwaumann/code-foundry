/**
 * Which panes fold to rails when the window cannot keep every pane at its minimum
 * (docs/notes/shell-model.md, "Small windows"). Derived per frame from the area: nothing here
 * changes the stored layout, and computing again on a larger area unfolds what now fits.
 *
 * Order: panes without a thread tab first, then panes with one; within each, the least recently
 * focused first (a pane whose tabs were never focused before any that were), and among equals the
 * later pane in layout order first. The focused pane and the pane holding the focused thread's
 * tab never fold. A fold is kept only when it shrinks a dimension that does not fit; once the
 * tree fits, the folded panes are tried again in reverse order and each one that still fits
 * unfolds. See docs/notes/shell-9-geometry.md.
 */
import { frameRects, minimumOf, paneMinimum, type MinimumOf } from "./rects";
import { activeTab, panesOf, type Frame, type GeoNode, type GeoPane } from "./types";

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

/** The panes to draw as rails in this area. */
export function foldRails({ root, w, h, focus, mru, minimum = paneMinimum }: RailsInput): Set<string> {
  const rails = new Set<string>();
  let m = minimumOf(root, rails, minimum);
  const fits = (s: { w: number; h: number }) => s.w <= w && s.h <= h;
  if (fits(m)) return rails;
  const folded: string[] = [];
  for (const id of foldOrder(root, focus, mru)) {
    if (fits(m)) break;
    rails.add(id);
    const next = minimumOf(root, rails, minimum);
    if ((m.w > w && next.w < m.w) || (m.h > h && next.h < m.h)) {
      m = next;
      folded.push(id);
    } else {
      rails.delete(id);
    }
  }
  if (!fits(m)) return rails;
  for (const id of folded.reverse()) {
    rails.delete(id);
    if (!fits(minimumOf(root, rails, minimum))) rails.add(id);
  }
  return rails;
}

/** The frame the window draws: rails folded for this area, then the rectangles. */
export function shellFrame(input: RailsInput): Frame {
  return frameRects(input.root, input.w, input.h, foldRails(input), input.minimum);
}
