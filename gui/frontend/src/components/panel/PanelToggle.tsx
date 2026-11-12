import { PanelRight } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { cn } from "@/lib/utils";
import { usePanelExpanded, usePanelOpen } from "@/stores/panel";
import { PANEL_MIN, panelMax, useUiStore, visibleSidebarWidth } from "@/stores/ui";
import { useShellPane } from "@/shell/paneContext";

/** Whether the current selection's panel is rendered (open, and room for it or expanded; see SidePanel). */
function usePanelShown(): boolean {
  const open = usePanelOpen();
  const expanded = usePanelExpanded();
  const room = useUiStore((s) => panelMax(s.windowWidth, visibleSidebarWidth(s)) >= PANEL_MIN);
  return open && (room || expanded);
}

/**
 * Button for view.panel.toggle. In a pane header (`inPanel` unset) it shows only while
 * the panel is not on screen; once the panel shows, the button lives in the panel's own
 * header (`inPanel`), so it always sits at the window's right edge. Headers drag the
 * window, so the button is always `no-drag`.
 */
export function PanelToggle({ className, inPanel = false }: { className?: string; inPanel?: boolean }) {
  // A shell pane has no side panel to toggle (docs/notes/shell-11-pane-grid.md).
  const inShell = useShellPane() !== null;
  const open = usePanelOpen();
  const shown = usePanelShown();
  if (inShell || shown !== inPanel) return null;
  return (
    <CommandButton
      command="view.panel.toggle"
      icon={PanelRight}
      pressed={open}
      className={cn("[--wails-draggable:no-drag]", open && "bg-cf-control-hover text-cf-text dark:bg-cf-control-hover/50", className)}
      data-testid="panel-toggle"
    />
  );
}
