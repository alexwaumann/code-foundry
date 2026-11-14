import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { GeoNode } from "@/shell/geometry/types";
import { GLYPH, spaceGlyph } from "@/shell/spaces";
import { useTree, type TreeNode } from "@/stores/layout";

/** A space's tree as the geometry reads it: only its structure matters to the glyph. */
function geoOf(n: TreeNode): GeoNode {
  if (n.t === "split") return { t: "split", id: n.id, dir: n.dir, kids: n.kids.map(geoOf), sizes: n.sizes };
  // A collapsed pane is laid out as a rail: a thin bar in the glyph (docs/notes/shell-25d-collapse.md).
  return { t: "pane", id: n.id, tabs: [], ...(n.collapsed ? { collapsed: true } : {}) };
}

/**
 * A space's glyph (docs/notes/shell-model.md, "Structure": "a small icon drawn from that space's
 * real pane layout"): each pane an outlined rectangle at its place, from the space's own tree laid
 * out plainly (shell/spaces.ts spaceGlyph), a collapsed pane as a thin bar. It follows the tree, so splitting or closing a pane
 * redraws it. Decorative: the tab names the space.
 */
export function SpaceIcon({ spaceId, className }: { spaceId: string; className?: string }) {
  const tree = useTree(spaceId);
  const rects = useMemo(() => spaceGlyph(tree ? geoOf(tree) : null), [tree]);
  return (
    <svg
      aria-hidden
      viewBox={`0 0 ${String(GLYPH.w)} ${String(GLYPH.h)}`}
      width={GLYPH.w}
      height={GLYPH.h}
      className={cn("shrink-0 overflow-visible", className)}
      data-testid="space-icon"
      data-panes={rects.length}
    >
      {rects.map((r, i) => (
        <rect
          key={i}
          x={r.x + 0.5}
          y={r.y + 0.5}
          width={Math.max(0.5, r.w - 1)}
          height={Math.max(0.5, r.h - 1)}
          rx={1.5}
          fill="none"
          stroke="currentColor"
          strokeWidth={1}
        />
      ))}
    </svg>
  );
}
