import { cn } from "@/lib/utils";
import { NodeView } from "../NodeList";
import type { NodeProps } from "../registry";

/** By align; an unknown one (a newer daemon's) is start. */
const justify: Partial<Record<string, string>> = {
  start: "justify-start",
  center: "justify-center",
  end: "justify-end",
  between: "justify-between",
};

/**
 * Leaf nodes on one line (docs/notes/plugins-layout-2-grid-inline.md): text, chips, actions
 * and progress (the daemon refuses other kinds), 8 px apart and centred vertically, placed
 * by align. They wrap onto more lines when they do not fit, unless noWrap (then they shrink
 * and wrap inside themselves). An item is as wide as its content; a progress bar grows to
 * the free width, at least 160 px.
 */
export function GroupNode({ node, data }: NodeProps<"group">) {
  const wrap = !(data.noWrap ?? false);
  const align = data.align ?? "start";
  return (
    <div
      role="group"
      className={cn("flex min-w-0 items-center gap-2", wrap ? "flex-wrap" : "flex-nowrap", justify[align] ?? "justify-start")}
      data-testid="plugin-group"
      data-key={node.key}
      data-align={align}
      data-wrap={wrap}
    >
      {data.items.map((n) => (
        <div key={n.key} className={cn("min-w-0", n.progress ? "shrink-0 grow basis-40" : "shrink")} data-testid="plugin-group-item" data-key={n.key}>
          <NodeView node={n} />
        </div>
      ))}
    </div>
  );
}
