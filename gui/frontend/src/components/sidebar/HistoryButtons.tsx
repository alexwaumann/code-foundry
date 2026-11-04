import { ChevronLeft, ChevronRight } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { canStepHistory, useUiStore } from "@/stores/ui";
import { selectAnyViewOpen, useViewsStore } from "@/stores/views";

/**
 * Back and Forward in the sidebar band, after the app name (view.back, view.forward). Each
 * dims when it would do nothing, as stores/views.ts historyCommand decides: Back also closes
 * Settings, Themes or Usage, none of which is a history entry.
 *
 * Their tooltips float down: there is no room above the band. The last glyph sits on the
 * sidebar's right edge, the menu card's edge, so the row is pushed right by
 * (24 - 14) / 2 = 5px (-mr-1.25), like the status row's last button (SidebarStatus). The
 * band drags the window, so the buttons opt out of it.
 *
 * A thread removed elsewhere leaves Back lit until the ui store next changes: pressing it
 * then prunes the entry, finds nothing and dims it.
 */
export function HistoryButtons() {
  const closesView = useViewsStore(selectAnyViewOpen);
  const canBack = useUiStore((s) => canStepHistory(s, -1));
  const canForward = useUiStore((s) => canStepHistory(s, 1));
  return (
    <span className="ml-auto -mr-1.25 flex shrink-0 items-center [--wails-draggable:no-drag]" data-testid="sidebar-history">
      <CommandButton command="view.back" icon={ChevronLeft} disabled={!canBack && !closesView} tooltipSide="bottom" data-testid="sidebar-back" />
      <CommandButton command="view.forward" icon={ChevronRight} disabled={!canForward} tooltipSide="bottom" data-testid="sidebar-forward" />
    </span>
  );
}
