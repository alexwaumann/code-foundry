import type { ViewNode } from "@/api/plugin";
import { cn } from "@/lib/utils";
import { StripRow } from "./StripRow";

/**
 * The view's footer (docs/notes/plugins-layout-3-chrome.md): pinned at the bottom of the
 * surface, under the scrolling body, with a hairline toward it and the panel's padding. A
 * form here keeps its drafts and busy state like one in the body. Part of the active view
 * tab's view.
 */
export function FooterBar({ nodes, stale }: { nodes: readonly ViewNode[]; stale?: boolean }) {
  return (
    <div className={cn("shrink-0 border-t border-pane-border bg-pane px-4 py-2 @max-[340px]:px-3", stale && "opacity-60 [&_.animate-spin]:animate-none")} role="region" aria-label="Footer" data-testid="plugin-footer">
      <StripRow nodes={nodes} slot="footer" />
    </div>
  );
}
