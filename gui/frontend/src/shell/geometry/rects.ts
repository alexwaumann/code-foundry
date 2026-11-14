/**
 * The pane tree to pixel rectangles. `plainRects` is the daemon's `layout.Rects`
 * (internal/layout/rects.go) to the px: proportions alone, what placement measures, with only the
 * panes the user collapsed drawn as rails. `frameRects` is what the window draws: the same tree
 * with each pane kept at its minimum where the area allows and the panes `rails.ts` folded (the
 * collapsed ones among them) drawn as 36px rails. Both tile the area exactly: edges
 * round to whole px (JavaScript's Math.round, as the Go side) and the last kid of a split runs to
 * its far edge, so a fractional area (page zoom) leaves no gap. See docs/notes/shell-9-geometry.md.
 */
import { activeTab, collapsedOf, type Frame, type GeoNode, type GeoPane, type Rect, type Size } from "./types";

/** The gap between panes, in layout px. */
export const GUTTER = 12;

/** A folded pane's thickness, in layout px. */
export const RAIL = 36;

/** What a pane needs by the kind of its active tab; kinds not listed take DEFAULT_MINIMUM. */
export const PANE_MINIMUMS: Readonly<Record<string, Size>> = {
  thread: { w: 360, h: 220 },
  compose: { w: 360, h: 220 },
  terminal: { w: 240, h: 110 },
  diff: { w: 260, h: 150 },
  file: { w: 260, h: 150 },
  pullrequest: { w: 260, h: 150 },
};

export const DEFAULT_MINIMUM: Size = { w: 300, h: 160 };

/** A pane's minimum size: what it needs to stay a pane rather than a rail. */
export type MinimumOf = (pane: GeoPane) => Size;

/** The minimum of a pane by its active tab's kind (an empty pane takes the default). */
export const paneMinimum: MinimumOf = (pane) => {
  const kind = activeTab(pane)?.kind ?? "";
  return PANE_MINIMUMS[kind] ?? DEFAULT_MINIMUM;
};

interface LayOptions {
  rails: ReadonlySet<string>;
  minimum: MinimumOf;
  /** Proportions alone: no minimums; the rails are the collapsed panes. */
  plain: boolean;
}

/** `rails` with the tree's collapsed panes added: a collapsed pane is always a rail. */
function withCollapsed(root: GeoNode | null, rails: ReadonlySet<string>): ReadonlySet<string> {
  const collapsed = collapsedOf(root);
  if (collapsed.size === 0) return rails;
  return new Set([...rails, ...collapsed]);
}

/** Whether every pane under n is a rail. */
function allRail(n: GeoNode, rails: ReadonlySet<string>): boolean {
  return n.t === "pane" ? rails.has(n.id) : n.kids.every((k) => allRail(k, rails));
}

function minOf(n: GeoNode, o: LayOptions): Size {
  if (n.t === "pane") return o.rails.has(n.id) ? { w: RAIL, h: RAIL } : o.minimum(n);
  const row = n.dir === "row";
  let w = 0;
  let h = 0;
  for (const k of n.kids) {
    const m = minOf(k, o);
    if (row) {
      w += m.w;
      h = Math.max(h, m.h);
    } else {
      h += m.h;
      w = Math.max(w, m.w);
    }
  }
  const gutters = GUTTER * Math.max(0, n.kids.length - 1);
  return row ? { w: w + gutters, h } : { w, h: h + gutters };
}

/**
 * The smallest area a tree fits in with the given rails folded: pane minimums, 36px rails and
 * 12px gutters summed along each split.
 */
export function minimumOf(
  root: GeoNode | null,
  rails: ReadonlySet<string> = new Set(),
  minimum: MinimumOf = paneMinimum,
): Size {
  return root ? minOf(root, { rails: withCollapsed(root, rails), minimum, plain: false }) : { w: 0, h: 0 };
}

/**
 * The lengths of a split's kids along its direction. A kid that is all rails takes its rails'
 * length along the split (plain: the collapsed panes are the rails); plain, the others share what
 * is left by `sizes`. Otherwise the others share what is left by
 * their sizes, and while their minimums fit, a kid whose share would fall short is held at its
 * minimum and the rest share again. When every kid is all rails they all share like open kids.
 * When the minimums do not fit, the open kids share what is left in proportion to their minimums,
 * so each falls short of its minimum by the same fraction (rails.ts leaves only the panes that
 * never fold open in that case).
 */
function lengths(kids: readonly GeoNode[], sizes: readonly number[], free: number, row: boolean, o: LayOptions) {
  const n = kids.length;
  let fixed = kids.map((k) => allRail(k, o.rails));
  if (fixed.every(Boolean)) fixed = fixed.map(() => false);
  const mins = kids.map((k, i) => (o.plain && !fixed[i] ? 0 : minOf(k, o)[row ? "w" : "h"]));
  const sz: number[] = Array.from({ length: n }, () => 0);
  const open: number[] = [];
  let ws = 0;
  for (let i = 0; i < n; i++) {
    if (fixed[i]) {
      sz[i] = Math.min(mins[i] ?? 0, free);
      free -= sz[i] ?? 0;
    } else {
      open.push(i);
      ws += sizes[i] ?? 0;
    }
  }
  const need = open.reduce((s, i) => s + (mins[i] ?? 0), 0);
  if (need > free + 0.5) {
    for (const i of open) sz[i] = Math.max(0, (free * (mins[i] ?? 0)) / need);
    return sz;
  }
  for (let again = true; again; ) {
    again = false;
    for (let j = 0; j < open.length; j++) {
      const i = open[j] ?? 0;
      const share = sizes[i] ?? 0;
      const min = mins[i] ?? 0;
      if (ws > 0 && (free * share) / ws < min - 0.01) {
        sz[i] = min;
        free -= min;
        ws -= share;
        open.splice(j, 1);
        again = true;
        break;
      }
    }
  }
  for (const i of open) sz[i] = ws > 0 ? Math.max(0, (free * (sizes[i] ?? 0)) / ws) : 0;
  return sz;
}

function lay(n: GeoNode, r: Rect, out: Frame, o: LayOptions): void {
  if (n.t === "pane") {
    out.rects[n.id] = { ...r, rail: o.rails.has(n.id) };
    return;
  }
  const row = n.dir === "row";
  const count = n.kids.length;
  const free = Math.max(0, (row ? r.w : r.h) - GUTTER * (count - 1));
  const sz = lengths(n.kids, n.sizes, free, row, o);
  const railKid = n.kids.map((k) => allRail(k, o.rails));
  let p = row ? r.x : r.y;
  const end = row ? r.x + r.w : r.y + r.h;
  n.kids.forEach((k, i) => {
    const s = sz[i] ?? 0;
    const a = Math.round(p);
    const b = i === count - 1 ? end : Math.round(p + s);
    lay(k, row ? { x: a, y: r.y, w: b - a, h: r.h } : { x: r.x, y: a, w: r.w, h: b - a }, out, o);
    if (i < count - 1) {
      const a2 = Math.round(p + s + GUTTER);
      const gap = row ? { x: b, y: r.y, w: a2 - b, h: r.h } : { x: r.x, y: b, w: r.w, h: a2 - b };
      out.gutters.push({ split: n.id, i, row, ...gap, fixed: !!(railKid[i] || railKid[i + 1]) });
    }
    p += s + GUTTER;
  });
}

function layout(root: GeoNode | null, w: number, h: number, o: LayOptions): Frame {
  const out: Frame = { w, h, rects: {}, gutters: [] };
  if (root) lay(root, { x: 0, y: 0, w, h }, out, o);
  return out;
}

/** The plain layout: proportions alone, no minimums, the collapsed panes as rails. Equal to the daemon's `Rects`. */
export function plainRects(root: GeoNode | null, w: number, h: number): Frame {
  return layout(root, w, h, { rails: collapsedOf(root), minimum: paneMinimum, plain: true });
}

/**
 * The drawn layout: the panes in `rails` (and the collapsed ones) as rails, the others held at
 * their minimums where the area allows. `rails.ts` chooses the rails; the stored tree is only read.
 */
export function frameRects(
  root: GeoNode | null,
  w: number,
  h: number,
  rails: ReadonlySet<string> = new Set(),
  minimum: MinimumOf = paneMinimum,
): Frame {
  return layout(root, w, h, { rails: withCollapsed(root, rails), minimum, plain: false });
}

/**
 * What keeps a frame from tiling its area exactly, empty when it does: every pane and gutter
 * inside the area, none overlapping another, and together covering all of it.
 */
export function tilingErrors(frame: Frame): string[] {
  const errs: string[] = [];
  const all: [string, Rect][] = [
    ...Object.entries(frame.rects),
    ...frame.gutters.map((g): [string, Rect] => [`gutter ${g.split}/${String(g.i)}`, g]),
  ];
  const eps = 1e-6;
  let area = 0;
  for (const [id, r] of all) {
    if (r.w < 0 || r.h < 0) errs.push(`${id} has a negative size`);
    if (r.x < -eps || r.y < -eps || r.x + r.w > frame.w + eps || r.y + r.h > frame.h + eps) {
      errs.push(`${id} leaves the area`);
    }
    area += r.w * r.h;
  }
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      const [ia, a] = all[i] ?? ["", { x: 0, y: 0, w: 0, h: 0 }];
      const [ib, b] = all[j] ?? ["", { x: 0, y: 0, w: 0, h: 0 }];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > eps && oy > eps) errs.push(`${ia} overlaps ${ib}`);
    }
  }
  if (all.length > 0 && Math.abs(area - frame.w * frame.h) > eps) {
    errs.push(`covers ${String(area)} of ${String(frame.w * frame.h)} px²`);
  }
  return errs;
}
