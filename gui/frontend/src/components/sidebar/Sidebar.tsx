import { useRef } from "react";
import { EmberRow } from "@/components/ember/EmberRow";
import { useHeight } from "@/lib/useWidth";
import { sidebarWidthAt, useUiStore } from "@/stores/ui";
import { ResizeHandle } from "./ResizeHandle";
import { useSidebarDashboard } from "./useLinkedPrs";
import { SidebarStatus } from "./SidebarStatus";
import { SidebarMenu } from "./SidebarMenu";
import { ShellSidebarList } from "./shell/ShellSidebarList";

/**
 * The sidebar under the top bar (components/shell/TopBar.tsx holds the app name and back and
 * forward): the menu pane (New thread, search), Ember's row, the thread list's sections and rows
 * (sidebar/shell; docs/notes/shell-16-sidebar.md) and the daemon status, beside its resize handle.
 */
export function Sidebar() {
  const visible = useUiStore((s) => s.sidebarVisible);
  const width = useUiStore((s) => sidebarWidthAt(s.sidebarWidth, s.zoom));
  if (!visible) return null;
  return <SidebarShown width={width} />;
}

function SidebarShown({ width }: { width: number }) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const bodyHeight = useHeight(bodyRef, 0);
  useSidebarDashboard();
  return (
    <aside className="relative flex shrink-0 flex-col bg-cf-sidebar" style={{ width }} data-testid="sidebar">
      {/* The panes float a shell gap (12px) off the sidebar. Rows run to the sidebar's edges, so
          the same gap on the left (pl-shell) keeps them as far from the window edge as from the panes. */}
      <div ref={bodyRef} className="flex min-h-0 flex-1 flex-col pl-shell" data-testid="sidebar-body">
        <SidebarMenu />
        <EmberRow />
        <ShellSidebarList bodyHeight={bodyHeight} />
        <SidebarStatus />
      </div>
      <ResizeHandle />
    </aside>
  );
}
