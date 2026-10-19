import { useContext, useMemo } from "react";
import { nodeScope } from "@/api/plugin";
import { cn } from "@/lib/utils";
import { actOnElement, usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { useViewCtx, ViewContext } from "../context";
import { listGap, useInnerList } from "../list";
import { LeavingNode } from "../live";
import { NodeList } from "../NodeList";
import type { NodeProps } from "../registry";
import { TabStrip } from "../TabStrip";

/**
 * A node's own tab strip over the active tab's nodes (docs/notes/plugins-layout-4-master-detail.md):
 * the view's tab strip one step smaller, in the list (not pinned). A click sends a `tab`
 * act on the tab's key (the daemon names this node in it); the clicked tab reads as
 * active while the act is pending, and the old tab's live nodes let go meanwhile
 * (live.ts LeavingNode). Its nodes are laid out like the list around it; their form drafts
 * are kept per tab (api/plugin.ts nodeScope).
 */
export function TabsNode({ node, data }: NodeProps<"tabs">) {
  const ctx = useViewCtx();
  const inner = useInnerList();
  const leaving = useContext(LeavingNode);
  const switching = usePluginSurfacesStore((s) => data.items.find((t) => t.key !== data.active && s.pending[ctx.watchKey]?.[t.key])?.key);
  const scope = nodeScope(node);
  const inside = useMemo(() => ({ ...ctx, viewTab: ctx.viewTab + scope }), [ctx, scope]);
  return (
    <div className={cn("flex min-w-0 shrink-0 flex-col", listGap(inner))} data-testid="plugin-tabs-node" data-key={node.key} data-active={data.active} data-switching={switching}>
      <TabStrip
        items={data.items}
        active={switching ?? data.active}
        onPick={(key) => void actOnElement(ctx.watchKey, key)}
        inert={ctx.inert}
        size="sm"
        label="Tabs"
        className="flex min-w-0 items-center gap-0.5"
        testId="plugin-node-tabs"
        tabTestId="plugin-node-tab"
      />
      <ViewContext.Provider value={inside}>
        <LeavingNode.Provider value={leaving || switching !== undefined}>
          <div className="flex min-w-0 flex-col" role="tabpanel" aria-label={data.items.find((t) => t.key === data.active)?.label} data-testid="plugin-tabs-panel">
            <NodeList nodes={data.children} inner={inner} />
          </div>
        </LeavingNode.Provider>
      </ViewContext.Provider>
    </div>
  );
}
