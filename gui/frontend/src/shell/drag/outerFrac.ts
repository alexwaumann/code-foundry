/**
 * The share a pane takes on an outer edge of the grid (docs/notes/shell-14b-outer-edge-size.md):
 * a port of internal/layout's `outerFrac` and `Kind.sizeIn`, used by the drop preview and the
 * mock's `move_tab` and `move_pane`, so both give the rectangle the daemon lands. A drop beside a
 * pane splits it in half; only the outer edge takes a kind's size.
 */
import { GUTTER, PANE_MINIMUM } from "../geometry/rects";

/** The width the rest keeps when a new pane is raised to its floor: a pane's minimum (internal/layout place.go KeepPx). */
export const KEEP_PX = PANE_MINIMUM.w;

/** The default share when a kind is unknown (internal/layout tree.go defaultFrac). */
const HALF = 0.5;

/**
 * Each kind's size: `frac` its default share, `floor` its least px when the rest keeps KEEP_PX
 * (internal/layout identity.go `DefaultFrac`, `FloorPx`; `outerFrac.test.ts` pins them to
 * testdata/kinds.json). "plugin." is the prefix of every plugin surface's kind.
 */
export const KIND_SIZES: Readonly<Record<string, { frac: number; floor?: number }>> = {
  compose: { frac: 0.5 },
  diff: { frac: 0.45, floor: 480 },
  "ember.board": { frac: 0.5 },
  file: { frac: 0.35 },
  gallery: { frac: 0.45 },
  mcp: { frac: 0.35 },
  "plugin.": { frac: 0.35 },
  projects: { frac: 0.5 },
  prs: { frac: 0.5 },
  pullrequest: { frac: 0.45, floor: 480 },
  terminal: { frac: 0.3 },
  thread: { frac: 0.5 },
};

/** A kind's size: an exact name, or "plugin.<plugin>.<surface>" (identity.go KindOf). */
export function kindSize(kind: string): { frac: number; floor?: number } | undefined {
  if (kind !== "plugin." && Object.hasOwn(KIND_SIZES, kind)) return KIND_SIZES[kind];
  if (!kind.startsWith("plugin.")) return undefined;
  const rest = kind.slice("plugin.".length);
  const i = rest.indexOf(".");
  return i > 0 && i < rest.length - 1 ? KIND_SIZES["plugin."] : undefined;
}

/** The tree's root as outerFrac reads it: whether a split, which way, and how many kids. */
interface RootLike {
  t: string;
  dir?: string;
  kids?: readonly unknown[];
}

/**
 * The share a pane whose active tab is of `kind` takes on `edge` of a `w` x `h` pane area (0 when
 * unknown) whose tree is `root` before it goes in: `frac` when one is given; otherwise the kind's
 * default share of the area along that axis less its gutters, raised to its floor when the area
 * is known and the rest still keeps KEEP_PX.
 */
export function outerFrac(root: RootLike | null, kind: string | undefined, edge: "left" | "right" | "top" | "bottom", frac: number | undefined, w: number, h: number): number {
  if (frac) return frac;
  const k = kind === undefined ? undefined : kindSize(kind);
  if (!k) return HALF;
  const dir = edge === "left" || edge === "right" ? "row" : "col";
  const length = dir === "row" ? w : h;
  // The panes along the axis once it is in: it joins a root split that runs that way.
  const count = root && root.t === "split" && root.dir === dir ? (root.kids?.length ?? 0) + 1 : 2;
  const room = length - GUTTER * (count - 1);
  if (!(room > 0) || !Number.isFinite(room)) return k.frac;
  let px = k.frac * room;
  if (k.floor && px < k.floor && room - k.floor >= KEEP_PX) px = k.floor;
  return px / room;
}
