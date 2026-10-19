import type { ViewNode } from "@/api/plugin";
import { nodeKind } from "@/api/plugin";
import { InnerList } from "./list";
import { NodeView } from "./NodeList";
import { InStrip, STRIP_MAX_NODES, stripItemClass, type StripSlot } from "./strip";

/** A toolbar's or footer's nodes in one row, 8 px apart, wrapping onto more rows when they do not fit (strip.ts). */
export function StripRow({ nodes, slot }: { nodes: readonly ViewNode[]; slot: StripSlot }) {
  const shown = nodes.slice(0, STRIP_MAX_NODES);
  return (
    <InStrip.Provider value={slot}>
      <InnerList.Provider value={true}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1.5">
          {shown.map((n) => (
            <div key={n.key} className={stripItemClass(n, shown)} data-testid="plugin-strip-item" data-key={n.key} data-kind={nodeKind(n) ?? undefined}>
              <NodeView node={n} />
            </div>
          ))}
        </div>
      </InnerList.Provider>
    </InStrip.Provider>
  );
}
