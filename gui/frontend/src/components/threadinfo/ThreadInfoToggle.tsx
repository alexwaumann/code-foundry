import { SquareChartGantt } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { useThreadCtx } from "@/components/thread/context";
import { cn } from "@/lib/utils";
import { useCardRoom } from "@/stores/threadInfoOverlay";
import { useUiStore } from "@/stores/ui";

/**
 * Button for view.thread-info in the thread header's actions: pressed while the card shows,
 * inline beside the conversation or, without room for it, as the overlay. On a narrow pane
 * with the overlay hidden it is not pressed, the inline card's preference notwithstanding
 * (docs/notes/thread-info-overlay.md). Headers drag the window, so `no-drag`.
 */
export function ThreadInfoToggle() {
  const { threadId } = useThreadCtx();
  const open = useUiStore((s) => s.threadInfoOpen);
  const shown = useCardRoom((s) => (s.room ? open : s.overlayFor === threadId));
  return (
    <CommandButton
      command="view.thread-info"
      icon={SquareChartGantt}
      pressed={shown}
      className={cn("[--wails-draggable:no-drag]", shown && "bg-cf-control-hover text-cf-text dark:bg-cf-control-hover/50")}
      data-testid="thread-info-toggle"
    />
  );
}
