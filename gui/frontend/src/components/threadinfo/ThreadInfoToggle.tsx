import { SquareChartGantt } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { cn } from "@/lib/utils";
import { NO_ROOM_REASON } from "@/lib/threadInfo";
import { useCardRoom } from "@/stores/threadInfo";
import { useUiStore } from "@/stores/ui";

/**
 * Button for view.thread-info in the thread header's actions: pressed while this window
 * has the thread info card on, also while the pane is too narrow to show it (ThreadPane):
 * its tooltip then says so. Headers drag the window, so `no-drag`.
 */
export function ThreadInfoToggle() {
  const open = useUiStore((s) => s.threadInfoOpen);
  const room = useCardRoom((s) => s.room);
  return (
    <CommandButton
      command="view.thread-info"
      icon={SquareChartGantt}
      pressed={open}
      tooltip={open && !room ? NO_ROOM_REASON : undefined}
      className={cn("[--wails-draggable:no-drag]", open && "bg-cf-control-hover text-cf-text dark:bg-cf-control-hover/50")}
      data-testid="thread-info-toggle"
    />
  );
}
