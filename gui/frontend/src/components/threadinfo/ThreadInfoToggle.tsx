import { SquareChartGantt } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { useThreadCtx } from "@/components/thread/context";
import { cn } from "@/lib/utils";
import { roomFor, useCardRoom, useThreadInfoOpen } from "@/stores/threadInfoOverlay";

/**
 * Button for view.thread-info in the thread header's actions: pressed while the card shows,
 * inline beside the conversation or, without room for it, as the overlay. On a narrow pane
 * with the overlay hidden it is not pressed, the thread's own choice notwithstanding
 * (docs/notes/thread-info-overlay.md). Per thread: it shows this thread's state. Headers drag the window, so `no-drag`.
 */
export function ThreadInfoToggle() {
  const { threadId } = useThreadCtx();
  const open = useThreadInfoOpen(threadId);
  const shown = useCardRoom((s) => (roomFor(s, threadId) ? open : s.overlayFor === threadId));
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
