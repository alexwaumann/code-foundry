import { BottomToggle } from "@/components/bottom/BottomToggle";
import { PanelToggle } from "@/components/panel/PanelToggle";
import { ThreadInfoToggle } from "@/components/threadinfo/ThreadInfoToggle";

/**
 * The thread header's right side: the window's three toggles, the thread info card, the
 * bottom panel and the side panel. The thread's own actions are its title menu's
 * (ThreadParts), and its pull requests, flags and place are the card's.
 */
export function HeaderActions() {
  return (
    <span className="-mr-1.5 flex items-center [--wails-draggable:no-drag]" data-testid="pane-actions">
      <ThreadInfoToggle />
      <BottomToggle />
      <PanelToggle />
    </span>
  );
}
