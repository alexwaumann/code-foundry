import { useRef } from "react";
import { cn } from "@/lib/utils";
import { FILL_MIN, useNodeHeight } from "../height";
import { useInnerList } from "../list";
import { NodeList } from "../NodeList";
import type { NodeProps } from "../registry";

/**
 * A box of nodes with its own height and scroll (docs/notes/plugins-layout-1-columns-pane.md):
 * "auto" (absent) as tall as its nodes, at least minHeight; pixels as given; "fill" the rest
 * of its own box (components/plugin/height.ts), at least minHeight or FILL_MIN. A px or
 * fill pane is the box its fill nodes fill (data-fill-box, height.ts FILL_BOX_ATTR). Taller nodes scroll inside it, or are cut with
 * noScroll. It draws nothing of its own and lays its nodes out like the list around it;
 * a sized pane's list is its box's own (list.ts BoxList: a flex spacer reaches its bottom).
 */
export function PaneNode({ node, data }: NodeProps<"pane">) {
  const inner = useInnerList();
  const ref = useRef<HTMLDivElement>(null);
  const floor = data.minHeight !== undefined && data.minHeight > 0 ? data.minHeight : FILL_MIN;
  const height = useNodeHeight(ref, data.height, undefined, floor);
  const mode = data.height === "fill" ? "fill" : typeof data.height === "number" ? "px" : "auto";
  const sized = mode !== "auto";
  const scroll = !(data.noScroll ?? false);
  return (
    <div
      ref={ref}
      className={cn("flex min-w-0 shrink-0 flex-col", sized && (scroll ? "overflow-x-hidden overflow-y-auto overscroll-contain" : "overflow-hidden"))}
      style={{ height, minHeight: mode === "auto" ? data.minHeight : undefined }}
      data-testid="plugin-pane"
      data-key={node.key}
      data-height={mode}
      data-scroll={sized ? scroll : undefined}
      data-fill-box={sized || undefined}
    >
      <NodeList nodes={data.children} inner={inner} box={sized} />
    </div>
  );
}
