import { Bell, BellRing, LayoutDashboard, Plus } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { jumpToAttention } from "@/keys/bindings";
import { cn } from "@/lib/utils";
import { useEmberAttention } from "@/stores/ember";
import { useShowCreatedThreads } from "@/stores/settings";
import { useAttentionCount } from "@/stores/threads";
import { isDashboard, useUiStore } from "@/stores/ui";

/**
 * Notifications: the threads waiting on the user, Ember's included (stores/ember.ts).
 * Always shown; with a count, a click jumps to the next one (as cmd+shift+a does). With
 * none it does nothing, but still shows its tooltip, so it is aria-disabled rather than
 * disabled (disabled buttons get no hover).
 */
function NotificationsButton() {
  const count = useAttentionCount(useShowCreatedThreads()) + (useEmberAttention() ? 1 : 0);
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
        className={cn("relative", count > 0 ? "text-cf-warning-text hover:text-cf-warning-text" : "opacity-50 hover:bg-transparent dark:hover:bg-transparent")}
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
            className="absolute -top-1 -right-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-cf-warning px-[3px] text-overline leading-none font-semibold tracking-normal text-cf-warning-foreground tabular-nums"
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
 * Notifications. Not part of the window drag area. New thread is the first nav row
 * under it (SidebarNewThread). See docs/notes/sidebar-toolbar.md and
 * docs/notes/onboarding-1-entry-points.md.
 *
 * The first button's glyph sits on the sidebar's left gutter line (where the New thread
 * row and the rows start): an icon-xs box is 24px (size-6) around a 14px glyph
 * (size-3.5), so it is pulled left by (24 - 14) / 2 = 5px (-ml-1.25). Its hover and
 * current background still show the whole box. docs/notes/design-system-2-shell.md.
 */
export function SidebarToolbar() {
  const dashboard = useUiStore((s) => isDashboard(s.selection));
  return (
    <div
      role="toolbar"
      aria-label="Sidebar"
      className="flex h-8 shrink-0 items-center gap-1 border-b border-cf-sidebar-border [--wails-draggable:no-drag]"
      data-testid="sidebar-toolbar"
    >
      <CommandButton
        command="view.dashboard"
        icon={LayoutDashboard}
        whenUnavailable="disable"
        current={dashboard}
        className={cn("-ml-1.25", dashboard && "bg-cf-sidebar-row-selected text-cf-sidebar-foreground hover:bg-cf-sidebar-row-selected dark:hover:bg-cf-sidebar-row-selected")}
        data-testid="sidebar-dashboard"
      />
      <NotificationsButton />
    </div>
  );
}

/**
 * New thread (thread.new) as the first row of the sidebar's nav group, above Pull Requests
 * and Projects and drawn like them: a muted plus, the row's text role, the rows' hover.
 * It used to be a filled accent button with the chord as a hint, which was the loudest
 * thing in the sidebar for an action taken a few times a day; the chord now lives in the
 * palette and help only. Runs exactly what the palette does (the project picker).
 * docs/notes/sidebar-new-thread-row.md.
 */
export function SidebarNewThread() {
  return (
    <CommandButton
      command="thread.new"
      variant="ghost"
      whenUnavailable="disable"
      className="mt-1.5 h-7 w-full shrink-0 justify-start gap-2 px-2 text-body-sm font-normal text-cf-sidebar-foreground hover:bg-cf-sidebar-row-hover hover:text-cf-sidebar-foreground has-[>svg]:px-2 dark:hover:bg-cf-sidebar-row-hover [--wails-draggable:no-drag]"
      data-testid="sidebar-new-thread"
    >
      <Plus aria-hidden className="size-4 shrink-0 text-cf-icon-muted" />
      <span className="min-w-0 flex-1 truncate text-left">New thread</span>
    </CommandButton>
  );
}
