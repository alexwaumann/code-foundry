import { NotificationItem } from "@/components/notifications/NotificationCard";
import { useThreadNotificationIds } from "@/stores/notifications";

/**
 * The thread card's notifications (docs/notes/notifications-4-row-mark.md): under a "Notifications"
 * overline, one card per shown notification naming the thread, in the daemon's order
 * (time-sensitive first, then the newest), each the bell's own card with its Snooze, Dismiss and
 * the plugin's buttons, without the link to the thread (the card is that thread's). The cards run
 * to the card's edges and its foot, divided by hairlines; past about two and a half cards the
 * section scrolls on its own. Nothing, not even the overline, with none. Mounted only while the
 * card is open. `onMenuOpenChange` tells the card a snooze menu is up (ThreadTooltip holds it open).
 */
export function TipNotifications({ id, onMenuOpenChange }: { id: string; onMenuOpenChange: (open: boolean) => void }) {
  const ids = useThreadNotificationIds(id);
  if (ids.length === 0) return null;
  return (
    <div className="-mx-2.5 -mb-2" data-testid="tip-notifications" data-count={ids.length}>
      <div className="mt-2.5 mb-1.5 px-2.5 text-overline text-cf-text-muted" data-testid="tip-notifications-label">
        Notifications
      </div>
      <div className="max-h-80 overflow-y-auto overscroll-contain rounded-b-md" data-testid="tip-notifications-list">
        {ids.map((nid) => (
          <NotificationItem key={nid} id={nid} hideThread className="border-t border-cf-divider" onMenuOpenChange={onMenuOpenChange} />
        ))}
      </div>
    </div>
  );
}
