import { Bell, BellRing, LayoutDashboard, SquarePen } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { Button } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Tip } from "@/components/ui/tooltip";
import { jumpToAttention } from "@/keys/bindings";
import { formatChord } from "@/keys/chord";
import { cn } from "@/lib/utils";
import { useCommandsStore } from "@/stores/commands";
import { useAttentionCount } from "@/stores/threads";
import { isDashboard, useUiStore } from "@/stores/ui";

/**
 * Notifications: the sessions waiting on the user. Always shown; with a count, a click
 * jumps to the next one (as cmd+shift+a does). With none it does nothing, but still shows
 * its tooltip, so it is aria-disabled rather than disabled (disabled buttons get no hover).
 */
function NotificationsButton() {
  const count = useAttentionCount();
  const label = count === 0 ? "No threads need attention" : `${String(count)} ${count === 1 ? "thread needs" : "threads need"} attention`;
  const Icon = count > 0 ? BellRing : Bell;
  return (
    <Tip label={label}>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        tabIndex={-1}
        aria-label={label}
        aria-disabled={count === 0 || undefined}
        data-testid="sidebar-notifications"
        data-count={count}
        className={cn("relative", count > 0 ? "text-warning hover:text-warning" : "opacity-50 hover:bg-transparent dark:hover:bg-transparent")}
        onMouseDown={(e) => {
          e.preventDefault();
        }}
        onClick={() => {
          if (count > 0) jumpToAttention();
        }}
      >
        <Icon aria-hidden className="size-3.5" />
        {count > 0 && (
          <span
            aria-hidden
            data-testid="attention-badge"
            className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-warning px-[3px] text-overline leading-none font-semibold tracking-normal text-warning-foreground tabular-nums"
          >
            {count}
          </span>
        )}
      </Button>
    </Tip>
  );
}

/**
 * The row of icon buttons under the sidebar's title band: Dashboard (view.dashboard) and
 * Notifications. Not part of the window drag area. New thread is the labelled button
 * under it (SidebarNewThread). See docs/notes/sidebar-toolbar.md and
 * docs/notes/onboarding-1-entry-points.md.
 *
 * The first button's glyph sits on the sidebar's left gutter line (where the New thread
 * button and the rows start): an icon-xs box is 24px (size-6) around a 14px glyph
 * (size-3.5), so it is pulled left by (24 - 14) / 2 = 5px (-ml-1.25). Its hover and
 * current background still show the whole box. docs/notes/design-system-2-shell.md.
 */
export function SidebarToolbar() {
  const dashboard = useUiStore((s) => isDashboard(s.selection));
  return (
    <div
      role="toolbar"
      aria-label="Sidebar"
      className="flex h-8 shrink-0 items-center gap-1 border-b border-sidebar-border [--wails-draggable:no-drag]"
      data-testid="sidebar-toolbar"
    >
      <CommandButton
        command="view.dashboard"
        icon={LayoutDashboard}
        whenUnavailable="disable"
        current={dashboard}
        className={cn("-ml-1.25", dashboard && "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent dark:hover:bg-sidebar-accent")}
        data-testid="sidebar-dashboard"
      />
      <NotificationsButton />
    </div>
  );
}

/**
 * The sidebar's primary action: a full-width "New thread" button (thread.new) under the
 * toolbar, with the command's first chord (cmd+n unless rebound; none when unbound) as a
 * muted hint on the right. Runs exactly what the palette does (the project picker).
 */
export function SidebarNewThread() {
  const chord = useCommandsStore((s) => s.commands.find((c) => c.name === "thread.new")?.keybindings[0] ?? null);
  return (
    <CommandButton
      command="thread.new"
      variant="default"
      whenUnavailable="disable"
      className="mt-1.5 h-8 w-full shrink-0 justify-start gap-2 px-2 text-body-sm font-medium has-[>svg]:px-2 [--wails-draggable:no-drag]"
      data-testid="sidebar-new-thread"
    >
      <SquarePen aria-hidden className="size-4" />
      <span className="min-w-0 flex-1 truncate text-left">New thread</span>
      {chord && (
        <Kbd variant="inherit" data-testid="sidebar-new-thread-chord">
          {formatChord(chord)}
        </Kbd>
      )}
    </CommandButton>
  );
}
