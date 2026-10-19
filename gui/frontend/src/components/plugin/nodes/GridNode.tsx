import { useState } from "react";
import { cn } from "@/lib/utils";
import { gridColumns, gridMinWidth, gridSpan, useElementWidth } from "../layout";
import { listGap, useInnerList } from "../list";
import { NodeList } from "../NodeList";
import type { NodeProps } from "../registry";

/**
 * Items in equal columns (docs/notes/plugins-layout-2-grid-inline.md): as many as fit the
 * node's own width at minWidth px each (components/plugin/layout.ts gridColumns: 240 px
 * unless set, at most 6), 12 px apart both ways; an item spans 1 or 2 of them (never more
 * than there are). An item's only node stretches to its row's height, so cards line up.
 * In one column (the side panel; and until the first measure) the items stack like the
 * list around the grid. One ResizeObserver per node follows its width.
 */
export function GridNode({ node, data }: NodeProps<"grid">) {
  const inner = useInnerList();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(el);
  const columns = gridColumns(width, gridMinWidth(data));
  const grid = columns > 1;
  return (
    <div
      ref={setEl}
      className={cn("min-w-0 shrink-0", grid ? "grid gap-3" : cn("flex flex-col", listGap(inner)))}
      style={grid ? { gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))` } : undefined}
      data-testid="plugin-grid"
      data-key={node.key}
      data-columns={columns}
      data-width={width ?? undefined}
    >
      {data.items.map((it) => {
        const span = gridSpan(it, columns);
        return (
          <div
            key={it.key}
            className="flex min-w-0 flex-col"
            style={span > 1 ? { gridColumn: `span ${String(span)} / span ${String(span)}` } : undefined}
            data-testid="plugin-grid-item"
            data-key={it.key}
            data-span={span}
          >
            <NodeList nodes={it.children} inner={inner} className={cn(grid && "grow [&>:only-child]:grow")} />
          </div>
        );
      })}
    </div>
  );
}
