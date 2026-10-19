import { ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { draftKeyOf, setCollapsed, useCollapsed } from "@/stores/pluginSurfaces";
import { useViewCtx } from "../context";
import { NodeList } from "../NodeList";
import { ButtonBar, InlineView, PillView } from "../parts";
import type { NodeProps } from "../registry";
import { toneBorder } from "../tones";

/**
 * Nodes under a title, optionally a card (MCP's box, tone border), collapsible (the whole
 * title row toggles; the user's toggle wins for the instance's life, per view tab, node tab
 * and selected row like drafts: stores/pluginSurfaces draftKeyOf) or stale (last known
 * data: dimmed, spinners stopped).
 */
export function SectionNode({ node, data }: NodeProps<"section">) {
  const { instance, viewTab } = useViewCtx();
  const toggleKey = draftKeyOf(instance, viewTab, node.key);
  const toggled = useCollapsed(toggleKey);
  const collapsible = data.collapsible ?? false;
  const collapsed = collapsible && (toggled ?? data.collapsed ?? false);
  const titleClass = cn("min-w-0 truncate text-overline", data.tone === "attention" && "text-warning", data.tone === "error" && "text-destructive");
  const hasHead = Boolean(data.title) || data.meta !== undefined || data.pill !== undefined || (data.actions?.length ?? 0) > 0 || collapsible;
  const label = (
    <>
      {collapsible && <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", !collapsed && "rotate-90")} aria-hidden />}
      {data.title && <span className={titleClass}>{data.title}</span>}
      {data.meta !== undefined && <InlineView value={data.meta} className="min-w-0 truncate text-caption-sm" />}
    </>
  );
  return (
    <section
      className={cn("flex min-w-0 flex-col gap-1.5", data.card && cn("rounded-lg border px-3 pt-2.5 pb-2", toneBorder[data.tone ?? ""]), data.stale && "opacity-60 [&_.animate-spin]:animate-none")}
      aria-label={data.title || undefined}
      data-testid="plugin-section"
      data-key={node.key}
      data-collapsed={collapsed || undefined}
      data-stale={data.stale || undefined}
    >
      {hasHead && (
        <div className="flex min-h-6 min-w-0 items-center gap-2">
          {collapsible ? (
            <button
              type="button"
              aria-expanded={!collapsed}
              className="-ml-0.5 flex min-w-0 flex-1 items-center gap-1.5 rounded-sm text-left outline-none focus-visible:ring-1 focus-visible:ring-ring"
              onClick={() => {
                setCollapsed(toggleKey, !collapsed);
              }}
              data-testid="plugin-section-toggle"
            >
              {label}
            </button>
          ) : (
            <div className="flex min-w-0 flex-1 items-center gap-1.5">{label}</div>
          )}
          <PillView pill={data.pill} />
          <ButtonBar buttons={data.actions} className="shrink-0 flex-nowrap" />
        </div>
      )}
      {!collapsed && data.children.length > 0 && <NodeList nodes={data.children} inner />}
    </section>
  );
}
