import { useState } from "react";
import { Bell } from "lucide-react";
import { VirtualStack } from "@/components/pr/VirtualStack";
import { VirtualScrollRoot } from "@/components/pr/virtualRoot";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { useBellTilt } from "@/stores/arrivals";
import { clearNotifications } from "@/stores/notificationActions";
import { setBellOpen, useBellCount, useNotificationsStore, useShownNotificationIds } from "@/stores/notifications";
import { NotificationItem } from "./NotificationCard";

/** A card's estimated height before it is measured: a title, a line of body, a row of buttons. */
const CARD_ESTIMATE = 112;

/**
 * The list: every shown notification in the daemon's order (time-sensitive first, then the
 * newest), divided by hairlines, scrolling on its own. A source holds at most 100 and any number
 * of plugins post, so it virtualizes past VirtualStack's threshold (40).
 */
function NotificationList({ ids }: { ids: readonly string[] }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null);
  return (
    <div ref={setRoot} className="max-h-[min(560px,calc(100vh/var(--cf-zoom)-120px))] overflow-y-auto" data-testid="notification-list">
      <VirtualScrollRoot value={root}>
        <VirtualStack items={ids} itemKey={(id) => id} estimate={CARD_ESTIMATE} render={(id) => <NotificationItem id={id} className="border-t border-cf-divider" />} />
      </VirtualScrollRoot>
    </div>
  );
}

/**
 * The top bar's bell (docs/notes/notifications-3-bell.md): the count of shown notifications, in
 * the attention tone while one of them is time-sensitive, nothing but the icon with none. It opens
 * the one global list (the same in every space) with Clear all. Its open state is the store's, so
 * an arrival does not toast while the list shows it and the "N more" toast can open it.
 */
export function NotificationBell() {
  const { count, urgent } = useBellCount();
  const open = useNotificationsStore((s) => s.open);
  const ids = useShownNotificationIds();
  // Only the glyph tilts when a notification arrives (lib/arrivals.ts); the count stays still.
  const { className: tiltClass, place: tiltPlace } = useBellTilt(Bell);
  const label = count === 0 ? "Notifications" : count === 1 ? "1 notification" : `${String(count)} notifications`;
  return (
    <Popover open={open} onOpenChange={setBellOpen}>
      <Tip label={label} side="bottom">
        <PopoverTrigger asChild>
          <button
            type="button"
            aria-label={label}
            className={cn(
              "flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-label font-medium tabular-nums outline-none [--wails-draggable:no-drag] hover:bg-cf-control-hover focus-visible:ring-1 focus-visible:ring-cf-focus aria-expanded:bg-cf-control-hover",
              urgent ? "text-cf-warning-text" : "text-cf-text-secondary",
            )}
            data-testid="notification-bell"
            data-count={count}
            data-urgent={urgent || undefined}
          >
            <Bell className={cn("size-4 shrink-0", urgent && "text-cf-text-secondary", tiltClass)} ref={tiltPlace} aria-hidden data-testid="notification-bell-icon" />
            {count > 0 && <span data-testid="notification-bell-count">{count}</span>}
          </button>
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        align="end"
        className="flex w-[420px] max-w-[calc(100vw/var(--cf-zoom)-24px)] flex-col p-0"
        data-testid="notification-popover"
        // The list takes the focus: a card's button focused at once would show its tooltip.
        onOpenAutoFocus={(e) => {
          e.preventDefault();
          if (e.currentTarget instanceof HTMLElement) e.currentTarget.focus();
        }}
      >
        <div className="flex h-11 shrink-0 items-center gap-1.5 px-3">
          <span className="text-subheading">Notifications</span>
          {count > 0 && (
            <span className="text-caption tabular-nums" data-testid="notification-popover-count">
              {count}
            </span>
          )}
          {count > 0 && (
            <Button
              variant="outline"
              size="xs"
              className="ml-auto rounded-full text-cf-text-secondary"
              data-testid="notification-clear"
              onClick={() => {
                void clearNotifications();
              }}
            >
              Clear all
            </Button>
          )}
        </div>
        {ids.length === 0 ? (
          <p className="border-t border-cf-divider px-3 py-4 text-body-sm text-cf-text-muted" data-testid="notification-empty">
            No notifications.
          </p>
        ) : (
          <NotificationList ids={ids} />
        )}
      </PopoverContent>
    </Popover>
  );
}
