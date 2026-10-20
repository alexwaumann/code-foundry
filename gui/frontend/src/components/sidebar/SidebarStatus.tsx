import { ChartColumn, CircleHelp, Command, Settings } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { DaemonStatus } from "@/components/status/DaemonStatus";
import { UpdateIndicator } from "@/components/update/UpdateIndicator";
import { cn } from "@/lib/utils";
import { useViewsStore } from "@/stores/views";

/**
 * The bottom of the sidebar, on the sheet: a pending update (when there is one) above
 * the daemon's status, with buttons for the palette, usage, help and settings. Hidden
 * with the sidebar.
 *
 * The last button's glyph sits on the sidebar's right edge (the rows' and New thread's
 * edge, a shell gap from the pane): an icon-xs box is 24px (size-6) around a 14px glyph
 * (size-3.5), so it is pushed right by (24 - 14) / 2 = 5px (-mr-1.25), as the toolbar's
 * first button is pulled left. The same rule vertically: the glyphs' bottom lands on the
 * content pane's bottom edge (a shell gap, 12px, above the window's), so the row (h-6)
 * ends 12 - 5 = 7px above it (pb-1.75). docs/notes/design-system-2-shell.md.
 */
export function SidebarStatus() {
  const usageOpen = useViewsStore((s) => s.usageOpen);
  const settingsOpen = useViewsStore((s) => s.settingsOpen);
  return (
    <div className="flex shrink-0 flex-col gap-0.5 pt-1 pb-1.75 text-caption-sm" data-testid="sidebar-status">
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
            className={cn("-mr-1.25", settingsOpen && "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent dark:hover:bg-sidebar-accent")}
            data-testid="status-settings"
          />
        </span>
      </div>
    </div>
  );
}
