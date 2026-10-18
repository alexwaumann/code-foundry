import type { ViewHeader } from "@/api/plugin";
import { inlineSpans } from "@/api/plugin";
import { InlineLine, InlineView, PillView, PluginButton, PluginIcon } from "./parts";

/**
 * The surface's identity and freshness line (MCP's header): the icon (neutral for every
 * plugin), title, trailing count and pill on the first line; the subline and at most two
 * icon-only actions on the second. Before the first view it is the manifest's icon and
 * title over "Loading…".
 */
export function SurfaceHeader({ header, fallbackTitle, icon, note }: { header: ViewHeader | undefined; fallbackTitle: string; icon: string; note?: string }) {
  const hasSubline = inlineSpans(header?.subline).length > 0 || (header?.actions?.length ?? 0) > 0 || Boolean(note);
  return (
    <header className="flex min-w-0 flex-col gap-0.5 border-b border-pane-border px-4 pt-2 pb-2.5 @max-[340px]:px-3" data-testid="plugin-header">
      <h2 className="flex min-w-0 items-center gap-1.5 text-heading">
        <PluginIcon name={header?.icon || icon} fallback="puzzle" className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate" data-testid="plugin-title">
          {header?.title || fallbackTitle}
        </span>
        {(header?.trailing !== undefined || header?.pill) && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-1">
            <InlineView value={header.trailing} className="text-caption tabular-nums" />
            <PillView pill={header.pill} />
          </span>
        )}
      </h2>
      {hasSubline && (
        <div className="flex min-h-6 min-w-0 items-center gap-1.5 text-caption" data-testid="plugin-subline">
          {header?.sublineIcon && <PluginIcon name={header.sublineIcon} className="size-3.5 shrink-0" />}
          {note ? <span className="min-w-0 truncate">{note}</span> : <InlineLine value={header?.subline} />}
          {header?.actions && header.actions.length > 0 && (
            <span className="ml-auto flex shrink-0 items-center gap-0.5">
              {header.actions.slice(0, 2).map((b) => (
                <PluginButton key={b.key} button={{ ...b, iconOnly: true }} />
              ))}
            </span>
          )}
        </div>
      )}
    </header>
  );
}
