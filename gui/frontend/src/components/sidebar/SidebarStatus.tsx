import { ChartColumn, CircleHelp, Command, Settings } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { DaemonStatus } from "@/components/status/DaemonStatus";
import { UpdateIndicator } from "@/components/update/UpdateIndicator";
import { useViewsStore } from "@/stores/views";

/**
 * The bottom of the sidebar, on the sheet: a pending update (when there is one) above
 * the daemon's status, with buttons for the palette, usage, help and settings. Hidden
 * with the sidebar.
 */
export function SidebarStatus() {
  const usageOpen = useViewsStore((s) => s.usageOpen);
  const settingsOpen = useViewsStore((s) => s.settingsOpen);
  return (
    <div className="flex shrink-0 flex-col gap-0.5 pt-1 pb-1.5 text-[11px] text-muted-foreground" data-testid="sidebar-status">
      <UpdateIndicator />
      <div className="flex h-6 min-w-0 items-center gap-2">
        <DaemonStatus />
        <span className="ml-auto flex shrink-0 items-center">
          <CommandButton command="ui.palette.open" icon={Command} tooltip="Command Palette" data-testid="status-palette" />
          {/* A toggle (stores/views.ts showView "usage"): pressed while the Usage page shows. */}
          <CommandButton
            command="view.usage"
            icon={ChartColumn}
            tooltip="Usage"
            pressed={usageOpen}
            className={usageOpen ? "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent dark:hover:bg-sidebar-accent" : undefined}
            data-testid="status-usage"
          />
          <CommandButton command="view.help" icon={CircleHelp} tooltip="Keyboard Shortcuts and Help" data-testid="status-help" />
          {/* A toggle like usage (showView "settings"): pressed while the settings page shows. */}
          <CommandButton
            command="view.settings"
            icon={Settings}
            tooltip="Settings"
            pressed={settingsOpen}
            className={settingsOpen ? "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent dark:hover:bg-sidebar-accent" : undefined}
            data-testid="status-settings"
          />
        </span>
      </div>
    </div>
  );
}
