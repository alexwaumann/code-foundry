import { Bell, BellRing, FolderPlus, LayoutDashboard, SquarePen } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { Button } from "@/components/ui/button";
import { jumpToAttention } from "@/keys/bindings";
import { cn } from "@/lib/utils";
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
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      tabIndex={-1}
      title={label}
      aria-label={label}
      aria-disabled={count === 0 || undefined}
      data-testid="sidebar-notifications"
      data-count={count}
      className={cn("relative", count > 0 ? "text-amber-600 hover:text-amber-600 dark:text-amber-300 dark:hover:text-amber-300" : "opacity-50 hover:bg-transparent dark:hover:bg-transparent")}
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
          className="absolute -top-1 -right-1 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-amber-500 px-[3px] text-[9px] leading-none font-semibold text-white tabular-nums dark:bg-amber-400 dark:text-black"
        >
          {count}
        </span>
      )}
    </Button>
  );
}

/**
 * The row of icon buttons under the sidebar's title band: Dashboard (view.dashboard) and
 * Notifications on the left; Add project (repo.add) and New thread (session.new) on the
 * right, New thread rightmost. Not part of the window drag area. See
 * docs/notes/sidebar-toolbar.md.
 */
export function SidebarToolbar() {
  const dashboard = useUiStore((s) => isDashboard(s.selection));
  return (
    <div
      role="toolbar"
      aria-label="Sidebar"
      className="flex h-8 shrink-0 items-center gap-1 border-b border-sidebar-border px-3 [--wails-draggable:no-drag]"
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
      <div className="flex-1" aria-hidden />
      <CommandButton command="repo.add" icon={FolderPlus} data-testid="sidebar-add-project" />
      <CommandButton command="session.new" icon={SquarePen} whenUnavailable="disable" data-testid="sidebar-new-session" />
    </div>
  );
}
