import { useState } from "react";
import { cn } from "@/lib/utils";
import { columnStyle, shownColumns, sideBySide, useElementWidth } from "../layout";
import { listGap, useInnerList } from "../list";
import { NodeList } from "../NodeList";
import type { NodeProps } from "../registry";

/**
 * 2 to 4 columns (docs/notes/plugins-layout-1-columns-pane.md): side by side, 12 px apart
 * and as tall as the tallest, where the node's own width fits them (components/plugin/
 * layout.ts: 240 px a weighted column, a fixed one its width); narrower, stacked in order
 * like the list around it, or only the first column with collapse "first". One
 * ResizeObserver per node follows its width; until it has one the columns stack.
 */
export function ColumnsNode({ node, data }: NodeProps<"columns">) {
  const inner = useInnerList();
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(el);
  const row = sideBySide(width, data.items);
  const shown = shownColumns(data, row);
  return (
    <div
      ref={setEl}
      className={cn("flex min-w-0 shrink-0", row ? "flex-row items-stretch gap-3" : cn("flex-col", listGap(inner)))}
      data-testid="plugin-columns"
      data-key={node.key}
      data-layout={row ? "row" : "stack"}
      data-collapse={data.collapse ?? "stack"}
      data-width={width ?? undefined}
    >
      {shown.map((c) => (
        <div key={c.key} className="flex min-w-0 flex-col" style={row ? columnStyle(c) : undefined} data-testid="plugin-column" data-key={c.key}>
          <NodeList nodes={c.children} inner={inner} className={cn(row && "flex-1")} />
        </div>
      ))}
    </div>
  );
}
