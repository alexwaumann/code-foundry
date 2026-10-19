import type { ReactNode } from "react";
import type { ViewNode } from "@/api/plugin";
import { FooterBar } from "./FooterBar";
import { ToolbarBar } from "./ToolbarBar";

/**
 * A surface's frame (docs/notes/plugins-layout-3-chrome.md): `top` (the header and the
 * plugin's tabs) and the toolbar pinned at the top, the footer pinned at the bottom, and
 * the body (`children`) scrolling between them in the surface's own scroll area
 * ([data-scroll-root]): fill nodes fill it (height.ts), so they end at the footer, and
 * live nodes count as on screen in it (live.ts). It fills the panel's body, which then
 * never scrolls itself. `stale` dims the strips like the body while the plugin is down.
 */
export function SurfaceFrame({ top, toolbar, footer, stale = false, children }: { top: ReactNode; toolbar: readonly ViewNode[]; footer: readonly ViewNode[]; stale?: boolean; children: ReactNode }) {
  return (
    <>
      <div className="shrink-0 bg-pane" data-testid="plugin-top">
        {top}
        {toolbar.length > 0 && <ToolbarBar nodes={toolbar} stale={stale} />}
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-scroll-root data-testid="plugin-scroll">
        {/* The 16 px under the body is the scroll area's bottom space (height.ts FILL_BOTTOM);
            grow: at least the area's height, so the body's list is its box (a flex spacer). */}
        <div className="flex min-w-0 grow flex-col pb-4">{children}</div>
      </div>
      {footer.length > 0 && <FooterBar nodes={footer} stale={stale} />}
    </>
  );
}
