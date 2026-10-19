import { nodeKind, type NodeKind, type ViewNode } from "@/api/plugin";
import { cn } from "@/lib/utils";
import { BoxList, InnerList, listGap } from "./list";
import { renderers } from "./nodes/index";
import type { NodeRenderer } from "./registry";

/** One view node by its kind's renderer (nodes/index.ts); a notice for a kind this GUI does not know. */
export function NodeView({ node }: { node: ViewNode }) {
  const kind = nodeKind(node);
  if (kind === null) {
    // The daemon refuses kinds it does not know, so only a newer daemon with an older GUI gets here.
    return (
      <p className="text-caption-sm italic" data-testid="plugin-unknown-node">
        This version of Code Foundry cannot show part of this view.
      </p>
    );
  }
  const Render = renderers[kind] as NodeRenderer<NodeKind>;
  const data = node[kind] as NonNullable<ViewNode[NodeKind]>;
  return <Render node={node} data={data} />;
}

/**
 * A list of view nodes: 12 px apart at the top level, 6 px inside sections and cards.
 * `box`: the list is its box's own (the surface's, a sized pane's; list.ts BoxList) and
 * grows to the box's height, so a flex spacer in it has room to take.
 */
export function NodeList({ nodes, inner = false, box = false, className }: { nodes: readonly ViewNode[]; inner?: boolean; box?: boolean; className?: string }) {
  return (
    <InnerList.Provider value={inner}>
      <BoxList.Provider value={box}>
        <div className={cn("flex min-w-0 flex-col", listGap(inner), box && "grow", className)} data-box-list={box || undefined}>
          {nodes.map((n) => (
            <NodeView key={n.key} node={n} />
          ))}
        </div>
      </BoxList.Provider>
    </InnerList.Provider>
  );
}
