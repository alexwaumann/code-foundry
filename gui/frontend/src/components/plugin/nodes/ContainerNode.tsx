import { containerMaxWidth } from "../layout";
import { useInnerList } from "../list";
import { NodeList } from "../NodeList";
import type { NodeProps } from "../registry";

/**
 * Caps its nodes' width and centres them (docs/notes/plugins-layout-3-chrome.md): "narrow"
 * at most 680 px, "wide" 1080 px, "full" (absent) no cap. In the side panel every width is
 * full; the cap applies where the surface is wider (a widened panel, a page). It draws
 * nothing of its own and lays its nodes out like the list around it.
 */
export function ContainerNode({ node, data }: NodeProps<"container">) {
  const inner = useInnerList();
  const max = containerMaxWidth(data.width);
  return (
    <div
      className="mx-auto flex w-full min-w-0 shrink-0 flex-col"
      style={max === null ? undefined : { maxWidth: max }}
      data-testid="plugin-container"
      data-key={node.key}
      data-width={data.width ?? "full"}
    >
      <NodeList nodes={data.children} inner={inner} />
    </div>
  );
}
