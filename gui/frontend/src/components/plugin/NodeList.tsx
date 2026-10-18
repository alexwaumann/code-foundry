import { nodeKind, type NodeKind, type ViewNode } from "@/api/plugin";
import { cn } from "@/lib/utils";
import { renderers } from "./nodes/index";
import type { NodeRenderer } from "./registry";

function NodeView({ node }: { node: ViewNode }) {
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

/** A list of view nodes: 12 px apart at the top level, 6 px inside sections and cards. */
export function NodeList({ nodes, inner = false }: { nodes: readonly ViewNode[]; inner?: boolean }) {
  return (
    <div className={cn("flex min-w-0 flex-col", inner ? "gap-1.5" : "gap-3")}>
      {nodes.map((n) => (
        <NodeView key={n.key} node={n} />
      ))}
    </div>
  );
}
