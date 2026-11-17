import type { ComponentProps } from "react";
import { ChartColumn, CircleHelp, Command, Settings } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { DaemonStatus } from "@/components/status/DaemonStatus";
import { UpdateIndicator } from "@/components/update/UpdateIndicator";
import { cn } from "@/lib/utils";
import { selectSheetOpen, useViewsStore } from "@/stores/views";

/**
 * The bottom of the sidebar, on the sheet: a pending update (when there is one) above
 * the daemon's status, with buttons for the palette, usage, help and settings. The rail
 * (sidebar/rail) reuses the palette, usage and settings buttons.
 *
 * The last button's glyph sits on the sidebar's right edge (the rows' and New thread's
 * edge, a shell gap from the pane): an icon-xs box is 24px (size-6) around a 14px glyph
 * (size-3.5), so it is pushed right by (24 - 14) / 2 = 5px (-mr-1.25), as the toolbar's
 * first button is pulled left. The same rule vertically: the glyphs' bottom lands on the
 * content pane's bottom edge (a shell gap, 12px, above the window's), so the row (h-6)
 * ends 12 - 5 = 7px above it (pb-1.75). docs/notes/design-system-2-shell.md.
 */
export function SidebarStatus() {
  return (
    <div className="flex shrink-0 flex-col gap-0.5 pt-1 pb-1.75 text-caption-sm" data-testid="sidebar-status">
      <UpdateIndicator />
      <div className="flex h-6 min-w-0 items-center gap-2">
        <DaemonStatus />
        <span className="ml-auto flex shrink-0 items-center">
          <PaletteButton />
          <UsageButton />
          <CommandButton command="view.help" icon={CircleHelp} tooltip="Keyboard Shortcuts and Help" data-testid="status-help" />
          <SettingsButton className="-mr-1.25" />
        </span>
      </div>
    </div>
  );
}

/** How a footer button is laid out: the expanded footer's (its own size) or the rail's (sidebar/rail). */
interface FooterButtonProps {
  className?: string;
  tooltipSide?: ComponentProps<typeof CommandButton>["tooltipSide"];
}

/** The pressed look of a footer toggle while its sheet shows. */
const PRESSED = "bg-cf-sidebar-row-selected text-cf-sidebar-foreground hover:bg-cf-sidebar-row-selected dark:hover:bg-cf-sidebar-row-selected";

/** The command palette (ui.palette.open). */
export function PaletteButton({ className, tooltipSide }: FooterButtonProps) {
  return <CommandButton command="ui.palette.open" icon={Command} tooltip="Command Palette" withKey tooltipSide={tooltipSide} className={className} data-testid="status-palette" />;
}

/** A toggle (stores/views.ts toggleView "usage"): pressed while the Usage sheet shows; under its backdrop, a click here closes it. */
export function UsageButton({ className, tooltipSide }: FooterButtonProps) {
  const usageOpen = useViewsStore((s) => s.usageOpen);
  return (
    <CommandButton
      command="view.usage"
      icon={ChartColumn}
      tooltip="Usage"
      tooltipSide={tooltipSide}
      pressed={usageOpen}
      className={cn(className, usageOpen && PRESSED)}
      data-testid="status-usage"
    />
  );
}

/** A toggle like usage (toggleView "settings"): pressed while the settings sheet (Settings or Themes) shows. */
export function SettingsButton({ className, tooltipSide }: FooterButtonProps) {
  const settingsOpen = useViewsStore(selectSheetOpen);
  return (
    <CommandButton
      command="view.settings"
      icon={Settings}
      tooltip="Settings"
      withKey
      tooltipSide={tooltipSide}
      pressed={settingsOpen}
      className={cn(className, settingsOpen && PRESSED)}
      data-testid="status-settings"
    />
  );
}
