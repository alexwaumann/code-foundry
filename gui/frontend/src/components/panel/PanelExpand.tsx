import { Maximize2, Minimize2 } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { cn } from "@/lib/utils";
import { usePanelExpanded } from "@/stores/panel";

/**
 * Button for view.panel.expand, in the panel's header left of its toggle. Maximize2 while
 * the panel shares the row with the content pane, Minimize2 (pressed) while it fills the
 * content area. Like PanelToggle it keeps the command's title in both states and reports
 * the state through aria-pressed. Headers drag the window, so it is `no-drag`.
 */
export function PanelExpand({ className }: { className?: string }) {
  const expanded = usePanelExpanded();
  return (
    <CommandButton
      command="view.panel.expand"
      icon={expanded ? Minimize2 : Maximize2}
      pressed={expanded}
      className={cn("[--wails-draggable:no-drag]", expanded && "bg-accent text-accent-foreground dark:bg-accent/50", className)}
      data-testid="panel-expand"
    />
  );
}
