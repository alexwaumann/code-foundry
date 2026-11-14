/**
 * Whether a drop's result fits (docs/notes/shell-model.md, "Room for panes";
 * docs/notes/shell-25f-sizes.md). A drop that would add an open pane (a pane's edge, the grid's
 * outer edge) or raise a pane's minimum (a tab other than a terminal joining a pane of
 * terminals) is offered only when the tree after it fits the pane area with no pane folded
 * automatically (`treeFits`, the daemon's `layout.Fits`). The tree after the drop is the daemon's
 * own edit replayed (`treeAfterDrop`), so the window offers exactly the drops the daemon takes:
 * internal/layout/testdata/drops.json lists the ones it refuses.
 */
import { terminalsOnly, treeFits } from "@/shell/geometry/rects";
import { panesOf, type GeoNode, type GeoPane, type GeoTab } from "@/shell/geometry/types";
import { treeAfterDrop, treeWithPaneBeside } from "./drop";
import type { DragSource, DropTarget } from "./targets";

/** A pane area in layout px. */
export interface Area {
  w: number;
  h: number;
}

/** The tabs a source brings into a pane: the dragged tab, a pane's tabs, a sidebar thread's tab. */
function arriving(root: GeoNode, source: DragSource): GeoTab[] {
  switch (source.kind) {
    case "thread":
      return [{ id: "", kind: "thread", thread: source.thread }];
    case "pane":
      return [...(panesOf(root).find((p) => p.id === source.pane)?.tabs ?? [])];
    case "tab": {
      const tab = panesOf(root)
        .find((p) => p.id === source.pane)
        ?.tabs?.find((t) => t.id === source.tab);
      return tab ? [tab] : [];
    }
  }
}

/** Whether tabs joining pane p raise its minimum: p holds only terminals and one of them is not one (Go's raises). */
export function raisesMinimum(p: GeoPane, tabs: readonly GeoTab[]): boolean {
  return terminalsOnly(p.tabs) && !terminalsOnly(tabs);
}

/**
 * Whether dropping `source` on `target` leaves a tree that fits `area`. A pane's middle or strip
 * (or a rail) is checked only when the drop raises that pane's minimum, and a collapsed pane takes
 * anything (the drop opens it, which is always allowed); an edge or the outer edge always. A drop
 * that changes nothing, or a tree that does not hold the source, counts as fitting (`targets.ts`
 * decides whether it is a target at all).
 */
export function dropFits(root: GeoNode | null, source: DragSource, target: DropTarget, area: Area): boolean {
  if (!root) return true;
  if (target.kind === "strip" || target.kind === "pane") {
    if (source.kind !== "thread" && source.pane === target.pane) return true;
    const into = panesOf(root).find((p) => p.id === target.pane);
    if (!into || into.collapsed || !raisesMinimum(into, arriving(root, source))) return true;
    const after = treeAfterDrop(root, source, { kind: "pane", pane: target.pane }, area);
    return !after || treeFits(after.root, area.w, area.h);
  }
  const after = treeAfterDrop(root, source, target, area);
  return !after || treeFits(after.root, area.w, area.h);
}

/**
 * Whether pane `pane` moved to another space (a pane dropped on its space tab, pane.move --space)
 * fits there: it goes right of that space's focused pane, or is the only pane of an empty space
 * (internal/layout MovePane). `root` and `focus` are the other space's.
 */
export function paneFitsInSpace(root: GeoNode | null, focus: string | undefined, pane: GeoPane, area: Area): boolean {
  if (!root) return true;
  return treeFits(treeWithPaneBeside(root, focus ?? "", "right", pane), area.w, area.h);
}

/** `root` with pane `id` replaced by what `f` makes of it. */
function mapPane(root: GeoNode, id: string, f: (p: GeoPane) => GeoPane): GeoNode {
  if (root.t === "pane") return root.id === id ? f(root) : root;
  return { ...root, kids: root.kids.map((k) => mapPane(k, id, f)) };
}

/**
 * Whether pane `paneId` can take a tab other than a terminal: its minimum does not rise (it is not
 * a pane of terminals, or it is collapsed), or the tree still fits `area` once it does. While it
 * cannot, its "+" lists only terminals (docs/notes/shell-model.md, "A pane's +").
 */
export function paneTakesAnyTab(root: GeoNode | null, paneId: string, area: Area): boolean {
  const pane = panesOf(root).find((p) => p.id === paneId);
  if (!root || !pane || pane.collapsed || !terminalsOnly(pane.tabs)) return true;
  const after = mapPane(root, paneId, (p) => ({ ...p, tabs: [...(p.tabs ?? []), { id: "", kind: "thread" }] }));
  return treeFits(after, area.w, area.h);
}
