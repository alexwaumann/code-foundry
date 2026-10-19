import { cn } from "@/lib/utils";
import { spacerSize } from "../layout";
import { useBoxList, useInnerList } from "../list";
import type { NodeProps } from "../registry";

/**
 * Extra space between its neighbours (docs/notes/plugins-layout-2-grid-inline.md): size px
 * (12 unless set) on top of the list's gap (it takes back one gap with a negative margin,
 * unless it is first). Flex, in its box's own list (list.ts BoxList: the surface's, a px or
 * fill pane's), it grows to the box's free height, so the nodes after it sit at the box's
 * bottom; anywhere else it is its size.
 */
export function SpacerNode({ node, data }: NodeProps<"spacer">) {
  const inner = useInnerList();
  const box = useBoxList();
  const size = spacerSize(data);
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
