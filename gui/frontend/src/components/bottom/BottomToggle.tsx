import { PanelBottom } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { cn } from "@/lib/utils";
import { useBottomOpen, useCurrentBottomKey } from "@/stores/bottomPanel";

/**
 * Button for view.bottom.toggle, left of the side panel's toggle in the pane headers of
 * a thread and the Projects page. Pressed while the selection's bottom panel is open.
 * Nothing for a selection without a bottom panel. Headers drag the window, so `no-drag`.
 */
export function BottomToggle({ className }: { className?: string }) {
  const key = useCurrentBottomKey();
  const open = useBottomOpen(key);
  if (key === null) return null;
  return (
    <CommandButton
      command="view.bottom.toggle"
      icon={PanelBottom}
      pressed={open}
      className={cn("[--wails-draggable:no-drag]", open && "bg-cf-control-hover text-cf-text dark:bg-cf-control-hover/50", className)}
      data-testid="bottom-toggle"
    />
  );
}
