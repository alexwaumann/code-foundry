/**
 * What a drop does (docs/notes/shell-14-drag.md): exactly one `tab.move` or `pane.move`
 * (internal/command commands_tab.go, commands_pane.go), and the rectangle the tab or pane will
 * take, found by applying the same tree edit the daemon makes (internal/layout ops_tree.go
 * MoveTab, MovePane, MergePane; tree.go removeNode, insertBeside, norm) to the drawn tree and
 * laying it out as the grid will.
 */
import { shellFrame } from "@/shell/geometry/rails";
import { frameRects } from "@/shell/geometry/rects";
import type { Frame, GeoNode, GeoTab, Rect } from "@/shell/geometry/types";
import { outerFrac } from "./outerFrac";
import type { DragSource, DropTarget, Edge } from "./targets";

/** A layout verb and its arguments. */
export interface DropCommand {
  name: "tab.move" | "pane.move";
  args: Record<string, string>;
}

/**
 * The command a drop runs, or null when it would change nothing: a tab put back in its own
 * place. `ownTabs` is the source pane's tab ids in strip order.
 */
export function dropCommand(source: DragSource, target: DropTarget, ownTabs: readonly string[]): DropCommand | null {
  // A sidebar thread opens first (threadDropSteps).
  if (source.kind === "thread") return null;
  if (source.kind === "pane") {
    const pane = source.pane;
    switch (target.kind) {
      case "strip":
        return {
          name: "pane.move",
          args: { pane, into: target.pane, index: String(target.index) },
        };
      case "pane":
        return { name: "pane.move", args: { pane, into: target.pane } };
      case "edge":
        return {
          name: "pane.move",
          args: { pane, beside: target.pane, edge: target.edge },
        };
      case "outer":
        return { name: "pane.move", args: { pane, outer: target.edge } };
    }
  }
  const tab = source.tab;
  switch (target.kind) {
    case "strip": {
      if (target.pane === source.pane) {
        const i = ownTabs.indexOf(tab);
        if (i >= 0 && (target.index === i || target.index === i + 1)) return null;
      }
      return {
        name: "tab.move",
        args: { tab, pane: target.pane, index: String(target.index) },
      };
    }
    case "pane":
      return { name: "tab.move", args: { tab, pane: target.pane } };
    case "edge":
      return {
        name: "tab.move",
        args: { tab, split: target.pane, edge: target.edge },
      };
    case "outer":
      return { name: "tab.move", args: { tab, outer: target.edge } };
  }
}

/** The share a drop beside a pane takes of it: half (tree.go defaultFrac). */
const HALF = 0.5;
const PREVIEW_PANE = "drop-preview-pane";
const PREVIEW_SPLIT = "drop-preview-split";

type Mut =
  | { t: "pane"; id: string; tabs: GeoTab[]; active?: string; collapsed?: boolean }
  | {
      t: "split";
      id: string;
      dir: "row" | "col";
      kids: Mut[];
      sizes: number[];
    };

function copy(n: GeoNode): Mut {
  if (n.t === "pane") return { t: "pane", id: n.id, tabs: [...(n.tabs ?? [])], active: n.active, ...(n.collapsed ? { collapsed: true } : {}) };
  return {
    t: "split",
    id: n.id,
    dir: n.dir,
    kids: n.kids.map(copy),
    sizes: [...n.sizes],
  };
}

/** Normal form (tree.go norm): no empty pane, no one-kid split, no split in a split of its direction, sizes summing to 1. */
function norm(n: Mut | null): Mut | null {
  if (!n) return null;
  if (n.t === "pane") return n.tabs.length > 0 ? n : null;
  const kids: Mut[] = [];
  const sizes: number[] = [];
  n.kids.forEach((k, i) => {
    const c = norm(k);
    if (!c) return;
    const s = n.sizes[i] ?? 1;
    if (c.t === "split" && c.dir === n.dir) {
      const tot = c.sizes.reduce((a, b) => a + b, 0);
      c.kids.forEach((g, j) => {
        kids.push(g);
        sizes.push((s * (c.sizes[j] ?? 0)) / tot);
      });
      return;
    }
    kids.push(c);
    sizes.push(s);
  });
  if (kids.length === 0) return null;
  if (kids.length === 1) return kids[0] ?? null;
  const tot = sizes.reduce((a, b) => a + b, 0);
  return { ...n, kids, sizes: sizes.map((s) => s / tot) };
}

function parentOf(root: Mut, id: string): { par: Extract<Mut, { t: "split" }> | null; i: number; node: Mut } | null {
  if (root.id === id) return { par: null, i: -1, node: root };
  if (root.t === "pane") return null;
  for (let i = 0; i < root.kids.length; i++) {
    const k = root.kids[i];
    if (!k) continue;
    if (k.id === id) return { par: root, i, node: k };
    const deeper = parentOf(k, id);
    if (deeper) return deeper;
  }
  return null;
}

/** Takes a node out; its room goes to the sibling before it (after it when first). tree.go removeNode. */
function removeNode(root: Mut, id: string): Mut | null {
  const at = parentOf(root, id);
  if (!at) return root;
  if (!at.par) return null;
  const { par, i } = at;
  const n = i > 0 ? i - 1 : i + 1;
  par.sizes[n] = (par.sizes[n] ?? 0) + (par.sizes[i] ?? 0);
  par.kids.splice(i, 1);
  par.sizes.splice(i, 1);
  return norm(root);
}

/** Puts `node` beside the node `id` on `edge`, taking `frac` of its room. tree.go insertBeside. */
function insertBeside(root: Mut | null, id: string, edge: Edge, node: Mut, frac: number): Mut {
  if (!root) return node;
  const at = parentOf(root, id);
  if (!at) return root;
  const dir = edge === "left" || edge === "right" ? "row" : "col";
  const before = edge === "left" || edge === "top";
  const { par, i, node: target } = at;
  if (par && par.dir === dir) {
    const s = par.sizes[i] ?? 0;
    par.sizes[i] = s * (1 - frac);
    const k = before ? i : i + 1;
    par.kids.splice(k, 0, node);
    par.sizes.splice(k, 0, s * frac);
    return norm(root) ?? node;
  }
  const split: Mut = {
    t: "split",
    id: PREVIEW_SPLIT,
    dir,
    kids: before ? [node, target] : [target, node],
    sizes: before ? [frac, 1 - frac] : [1 - frac, frac],
  };
  if (!par) return norm(split) ?? node;
  par.kids[i] = split;
  return norm(root) ?? node;
}

function findPane(root: Mut | null, id: string): Extract<Mut, { t: "pane" }> | null {
  if (!root) return null;
  const at = parentOf(root, id);
  return at?.node.t === "pane" ? at.node : null;
}

/**
 * The tree after a drop, and the id of the pane that then holds what was dropped (it takes the
 * focus, its dropped tab active): the daemon's own edit replayed (internal/layout ops_tree.go
 * MoveTab, MovePane, MergePane; tree.go detach, removeNode, insertBeside, norm). Null for a strip
 * (the insertion bar shows the place), a drop that changes nothing (a pane's only tab on its own
 * pane, a pane onto itself) or a tree that does not hold the source. An edge drop takes half of
 * the pane beside it; an outer edge the size of the dropped tab's kind (a pane's: its active
 * tab's) in the `w` x `h` pane area (`outerFrac`); a `frac` given (the fixtures') replaces it. A
 * pane's middle keeps the pane where it is in the tree, but what it is drawn at changes: the
 * dropped tab is its active one (its kind's minimum), it takes the focus (a rail unfolds), and a
 * pane the drop empties leaves the tree (internal/layout/testdata/drops.json holds the preview to
 * the daemon's result; docs/notes/shell-25b-audits.md).
 */
export function treeAfterDrop(root: GeoNode, source: DragSource, target: DropTarget, area: { w: number; h: number }, frac?: number): { root: GeoNode; pane: string } | null {
  if (target.kind === "strip") return null;
  let tree: Mut | null = copy(root);
  let moved: Extract<Mut, { t: "pane" }>;
  if (source.kind === "pane") {
    const pane = findPane(tree, source.pane);
    if (!pane || (target.kind !== "outer" && target.pane === pane.id)) return null;
    if (target.kind === "pane") {
      // Merged: its tabs join the end of the target's strip, its active tab active there.
      tree = removeNode(tree, pane.id);
      const into = findPane(tree, target.pane);
      if (!tree || !into) return null;
      into.tabs.push(...pane.tabs);
      into.active = pane.active;
      // It takes the focus: a collapsed pane opens (docs/notes/shell-25d-collapse.md).
      into.collapsed = false;
      return { root: tree as GeoNode, pane: into.id };
    }
    moved = pane;
    tree = removeNode(tree, pane.id);
  } else if (source.kind === "thread") {
    // Opened from the sidebar: a new tab, nothing leaves the tree.
    moved = { t: "pane", id: PREVIEW_PANE, tabs: [{ id: PREVIEW_PANE, kind: "thread", thread: source.thread }], active: PREVIEW_PANE };
    if (target.kind === "pane") {
      const into = findPane(tree, target.pane);
      if (!into) return null;
      into.tabs.push(...moved.tabs);
      into.active = PREVIEW_PANE;
      into.collapsed = false;
      return { root: tree as GeoNode, pane: into.id };
    }
  } else {
    const from = findPane(tree, source.pane);
    const at = from?.tabs.findIndex((t) => t.id === source.tab) ?? -1;
    const tab = from?.tabs[at];
    if (!from || !tab) return null;
    const rest = from.tabs.filter((t) => t !== tab);
    if (target.kind !== "outer" && target.pane === from.id && (target.kind === "pane" || rest.length === 0)) return null;
    from.tabs = rest;
    // The tab after it takes its place as the active one, else the one before (tree.go detach).
    if (from.active === tab.id) from.active = rest[Math.min(at, rest.length - 1)]?.id;
    moved = { t: "pane", id: PREVIEW_PANE, tabs: [tab], active: tab.id };
    if (rest.length === 0) tree = removeNode(tree, from.id);
    if (target.kind === "pane") {
      const into = findPane(tree, target.pane);
      if (!tree || !into) return null;
      into.tabs.push(tab);
      into.active = tab.id;
      into.collapsed = false;
      return { root: tree as GeoNode, pane: into.id };
    }
  }
  if (target.kind === "edge") {
    if (!tree || !findPane(tree, target.pane)) return null;
    return { root: insertBeside(tree, target.pane, target.edge, moved, frac || HALF) as GeoNode, pane: moved.id };
  }
  if (!tree) return { root: moved as GeoNode, pane: moved.id };
  const kind = moved.tabs.find((t) => t.id === moved.active)?.kind;
  const share = outerFrac(tree, kind, target.edge, frac, area.w, area.h);
  return { root: insertBeside(tree, tree.id, target.edge, moved, share) as GeoNode, pane: moved.id };
}

/** Lays out a tree after a drop: `moved` is the pane the drop makes or moves (it takes the focus). */
export type DropLayout = (root: GeoNode, w: number, h: number, moved: string) => Frame;

const plainDropLayout: DropLayout = (root, w, h) => frameRects(root, w, h);

/**
 * How the grid lays out the tree after a drop (the drag layer's `DropLayout`): rails folded as
 * `shellFrame` folds them, the dropped tab's or pane's pane holding the focus (the drop's command
 * gives it the focus), the space's `mru` for the fold order.
 */
export function shellDropLayout(mru: readonly string[] | undefined): DropLayout {
  return (root, w, h, moved) => shellFrame({ root, w, h, focus: moved, mru });
}

/**
 * The rectangle the dropped tab or pane will take, in the frame's coordinates: its pane in the
 * tree after the drop laid out at the frame's size (by `lay`: the grid passes its own, rails
 * included), for a pane's middle (a rail's whole) as for an edge or the outer edge; for a strip,
 * null (the insertion bar shows the place).
 */
export function dropPreview(root: GeoNode | null, frame: Frame, source: DragSource, target: DropTarget, lay: DropLayout = plainDropLayout): Rect | null {
  if (!root || target.kind === "strip") return null;
  const after = treeAfterDrop(root, source, target, frame);
  if (!after) return null;
  const r = lay(after.root, frame.w, frame.h, after.pane).rects[after.pane];
  return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null;
}
