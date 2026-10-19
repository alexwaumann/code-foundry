import { cn } from "@/lib/utils";
import { spacerSize } from "../layout";
import { useBoxList, useInnerList } from "../list";
import type { NodeProps } from "../registry";
import { useInStrip } from "../strip";

/**
 * Extra space between its neighbours (docs/notes/plugins-layout-2-grid-inline.md): size px
 * (12 unless set) on top of the list's gap (it takes back one gap with a negative margin,
 * unless it is first). Flex, in its box's own list (list.ts BoxList: the surface's, a px or
 * fill pane's), it grows to the box's free height, so the nodes after it sit at the box's
 * bottom; anywhere else it is its size. In a toolbar or footer (strip.ts) it is space
 * across: size px, or with flex what is left of the row's width (its strip item grows,
 * next to nothing beside a form or another grower: strip.ts), so what follows sits at the
 * row's end.
 */
export function SpacerNode({ node, data }: NodeProps<"spacer">) {
  const inner = useInnerList();
  const box = useBoxList();
  const strip = useInStrip() !== null;
  const size = spacerSize(data);
  if (strip) {
    const grows = data.flex ?? false;
    return <div aria-hidden style={grows ? { minWidth: size } : { width: size }} data-testid="plugin-spacer" data-key={node.key} data-size={size} data-flex={grows || undefined} data-strip />;
  }
  const flex = (data.flex ?? false) && box;
  return (
    <div
      aria-hidden
      className={cn("shrink-0 first:mt-0", inner ? "-mt-1.5" : "-mt-3", flex && "grow")}
      style={flex ? { minHeight: size } : { height: size }}
      data-testid="plugin-spacer"
      data-key={node.key}
      data-size={size}
      data-flex={flex || undefined}
    />
  );
}
