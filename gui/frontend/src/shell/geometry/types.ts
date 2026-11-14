/**
 * The plain shapes the shell's geometry works on. They follow the daemon's layout JSON
 * (internal/layout, plan 2.3: `t`, `id`, `tabs`, `active`, `dir`, `kids`, `sizes`), keeping only
 * what geometry reads, so a pane tree from the layout slice or a Go test fixture passes as is.
 * See docs/notes/shell-9-geometry.md.
 */

/** A tab as geometry sees it: its kind and the thread it belongs to ("" or absent: none). */
export interface GeoTab {
  id: string;
  kind: string;
  /** The thread; for a `thread` tab, the thread itself. */
  thread?: string;
}

/** A pane: one tile with a tab strip. */
export interface GeoPane {
  t: "pane";
  id: string;
  tabs?: readonly GeoTab[];
  /** The active tab's id. */
  active?: string;
  /** The user collapsed it (pane.collapse): always drawn as a rail. */
  collapsed?: boolean;
}

/** A split: its kids side by side ("row") or stacked ("col"), sharing its length by `sizes`. */
export interface GeoSplit {
  t: "split";
  id: string;
  dir: "row" | "col";
  kids: readonly GeoNode[];
  sizes: readonly number[];
}

export type GeoNode = GeoPane | GeoSplit;

/** A size in layout px. */
export interface Size {
  w: number;
  h: number;
}

/** A rectangle in layout px, from the pane area's top left. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A pane's rendered rectangle; `rail` when it is folded to a rail. */
export interface PaneRect extends Rect {
  rail: boolean;
}

/**
 * The gap after kid `i` of a split: a column gap in a row, a row gap in a column. `fixed` when a
 * side of it is all rails, so it does not resize.
 */
export interface GutterRect extends Rect {
  split: string;
  i: number;
  row: boolean;
  fixed: boolean;
}

/** A tree laid out in a w x h pane area: every pane's rectangle and every gutter's. */
export interface Frame {
  w: number;
  h: number;
  rects: Record<string, PaneRect>;
  gutters: GutterRect[];
}

/** The panes of a tree, in layout order. */
export function panesOf(root: GeoNode | null): GeoPane[] {
  const out: GeoPane[] = [];
  const walk = (n: GeoNode): void => {
    if (n.t === "pane") out.push(n);
    else n.kids.forEach(walk);
  };
  if (root) walk(root);
  return out;
}

/** The panes the user collapsed (docs/notes/shell-25d-collapse.md). */
export function collapsedOf(root: GeoNode | null): Set<string> {
  return new Set(panesOf(root).flatMap((p) => (p.collapsed ? [p.id] : [])));
}

/** A pane's active tab: the one `active` names, else its first. */
export function activeTab(p: GeoPane): GeoTab | undefined {
  const tabs = p.tabs ?? [];
  return tabs.find((t) => t.id === p.active) ?? tabs[0];
}
