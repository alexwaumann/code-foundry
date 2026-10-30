import { SquareChartGantt } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { cn } from "@/lib/utils";
import { useUiStore } from "@/stores/ui";

/**
 * Button for view.thread-info in the thread header's actions: pressed while this window
 * shows the thread info card. Headers drag the window, so `no-drag`.
 */
export function ThreadInfoToggle() {
  const open = useUiStore((s) => s.threadInfoOpen);
  return (
    <CommandButton
      command="view.thread-info"
      icon={SquareChartGantt}
      pressed={open}
      className={cn("[--wails-draggable:no-drag]", open && "bg-cf-control-hover text-cf-text dark:bg-cf-control-hover/50")}
      data-testid="thread-info-toggle"
    />
  );
}
