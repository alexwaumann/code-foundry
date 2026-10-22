import type { ViewNode } from "@/api/plugin";
import { cn } from "@/lib/utils";
import { StripRow } from "./StripRow";

/**
 * The view's toolbar (docs/notes/plugins-layout-3-chrome.md): pinned under the header and
 * the plugin's tabs, above the scrolling body, with a hairline toward it and the panel's
 * padding. Part of the active view tab's view: another tab's view brings its own or none.
 */
export function ToolbarBar({ nodes, stale }: { nodes: readonly ViewNode[]; stale?: boolean }) {
  return (
    <div className={cn("shrink-0 border-b border-cf-divider bg-cf-surface px-4 py-2 @max-[340px]:px-3", stale && "opacity-60 [&_.animate-spin]:animate-none")} role="region" aria-label="Toolbar" data-testid="plugin-toolbar">
      <StripRow nodes={nodes} slot="toolbar" />
    </div>
  );
}
