import { PanelRight } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { cn } from "@/lib/utils";
import { usePanelOpen } from "@/stores/panel";
import { PANEL_MIN, panelMax, useUiStore, visibleSidebarWidth } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";

/** Whether the current selection's panel is rendered (open, room for it, settings closed; see SidePanel). */
function usePanelShown(): boolean {
  const open = usePanelOpen();
  const room = useUiStore((s) => panelMax(s.windowWidth, visibleSidebarWidth(s)) >= PANEL_MIN);
  const settingsOpen = useViewsStore((s) => s.settingsOpen);
  return open && room && !settingsOpen;
}

/**
 * Button for view.panel.toggle. In a pane header (`inPanel` unset) it shows only while
 * the panel is not on screen; once the panel shows, the button lives in the panel's own
 * header (`inPanel`), so it always sits at the window's right edge. Headers drag the
 * window, so the button is always `no-drag`.
 */
export function PanelToggle({ className, inPanel = false }: { className?: string; inPanel?: boolean }) {
  const open = usePanelOpen();
  const shown = usePanelShown();
  if (shown !== inPanel) return null;
  return (
    <CommandButton
      command="view.panel.toggle"
      icon={PanelRight}
      pressed={open}
      className={cn("[--wails-draggable:no-drag]", open && "bg-accent text-accent-foreground dark:bg-accent/50", className)}
      data-testid="panel-toggle"
    />
  );
}
