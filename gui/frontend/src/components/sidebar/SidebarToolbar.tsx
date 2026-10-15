import { Bell, BellRing, LayoutDashboard, SquarePen } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { jumpToAttention } from "@/keys/bindings";
import { formatChord } from "@/keys/chord";
import { cn } from "@/lib/utils";
import { useCommandsStore } from "@/stores/commands";
import { useAttentionCount } from "@/stores/sessions";
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
            className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warning px-[3px] text-[9px] leading-none font-semibold text-warning-foreground tabular-nums"
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
        className={dashboard ? "bg-sidebar-accent text-sidebar-accent-foreground hover:bg-sidebar-accent dark:hover:bg-sidebar-accent" : undefined}
        data-testid="sidebar-dashboard"
      />
      <NotificationsButton />
    </div>
  );
}

/**
 * The sidebar's primary action: a full-width "New thread" button (session.new) under the
 * toolbar, with the command's first chord (cmd+n unless rebound; none when unbound) as a
 * muted hint on the right. Runs exactly what the palette does (the project picker).
 */
export function SidebarNewThread() {
  const chord = useCommandsStore((s) => s.commands.find((c) => c.name === "session.new")?.keybindings[0] ?? null);
  return (
    <CommandButton
      command="session.new"
      variant="default"
      whenUnavailable="disable"
      className="mt-1.5 h-8 w-full shrink-0 justify-start gap-2 px-2 text-[13px] has-[>svg]:px-2 [--wails-draggable:no-drag]"
      data-testid="sidebar-new-session"
    >
      <SquarePen aria-hidden className="size-4" />
      <span className="min-w-0 flex-1 truncate text-left">New thread</span>
      {chord && (
        <kbd className="shrink-0 font-sans text-[11px] text-primary-foreground/60" data-testid="sidebar-new-session-chord">
          {formatChord(chord)}
        </kbd>
      )}
    </CommandButton>
  );
}
