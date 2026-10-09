import { PanelRight } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { usePanelOpen } from "@/stores/panel";

/** Pane-header button for view.panel.toggle; highlighted while the selection's panel is open. */
export function PanelToggle({ className }: { className?: string }) {
  const open = usePanelOpen();
  return (
    <CommandButton
      command="view.panel.toggle"
      icon={PanelRight}
      pressed={open}
      className={open ? `bg-accent text-accent-foreground dark:bg-accent/50 ${className ?? ""}` : className}
      data-testid="panel-toggle"
    />
  );
}
