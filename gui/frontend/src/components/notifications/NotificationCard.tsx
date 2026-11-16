import { useState } from "react";
import { AlarmClock, InfoIcon, MessageSquare, OctagonXIcon, TriangleAlertIcon, XIcon, type LucideIcon } from "lucide-react";
import type { NotificationLevelView, NotificationView } from "@/api/notifications";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { useNowSelect } from "@/lib/clock";
import { formatAge } from "@/lib/duration";
import { sourceLabel } from "@/lib/notifications";
import { snoozePresets } from "@/lib/snooze";
import { cn } from "@/lib/utils";
import { actOnNotification, dismissNotification, goToNotificationThread, snoozeNotification } from "@/stores/notificationActions";
import { useNotification } from "@/stores/notifications";
import { usePlugin } from "@/stores/plugins";
import { useThreadsStore } from "@/stores/threads";

/** A level's icon (the toasts' own) and its tone. */
const LEVEL: Record<NotificationLevelView, { icon: LucideIcon; tone: string; word: string }> = {
  info: { icon: InfoIcon, tone: "text-cf-info-text", word: "Info" },
  warning: { icon: TriangleAlertIcon, tone: "text-cf-warning-text", word: "Warning" },
  error: { icon: OctagonXIcon, tone: "text-cf-error-text", word: "Error" },
};

const CORNER = "size-5 text-cf-text-muted hover:text-cf-text aria-expanded:text-cf-text";

/**
 * The card's snooze presets (lib/snooze.ts snoozePresets, the thread snooze's own four, each
 * with its time), computed when the menu opens. A notification has no "Save for later" (it
 * needs a time to come back) and no date dialog: those are the thread's.
 */
function SnoozeItems({ id }: { id: string }) {
  const [now] = useState(() => Date.now());
  return snoozePresets(now).map((p) => (
    <DropdownMenuItem
      key={p.id}
      data-testid="notification-snooze-preset"
      data-preset={p.id}
      onSelect={() => {
        void snoozeNotification(id, p.untilMs);
      }}
    >
      {p.label}
      <span className="ml-auto pl-6 text-caption tabular-nums">{p.hint}</span>
    </DropdownMenuItem>
  ));
}

/** The host's corner buttons: Snooze (its presets) and Dismiss. Never a plugin's. */
function CornerButtons({ id, onMenuOpenChange }: { id: string; onMenuOpenChange?: (open: boolean) => void }) {
  return (
    <span className="ml-1 flex shrink-0 items-center gap-0.5">
      <DropdownMenu modal={false} onOpenChange={onMenuOpenChange}>
        <Tip label="Snooze">
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-xs" className={CORNER} aria-label="Snooze" data-testid="notification-snooze">
              <AlarmClock className="size-3.5" aria-hidden />
            </Button>
          </DropdownMenuTrigger>
        </Tip>
        <DropdownMenuContent align="end" data-testid="notification-snooze-menu">
          <SnoozeItems id={id} />
        </DropdownMenuContent>
      </DropdownMenu>
      <Tip label="Dismiss">
        <Button
          variant="ghost"
          size="icon-xs"
          className={CORNER}
          aria-label="Dismiss"
          data-testid="notification-dismiss"
          onClick={() => {
            void dismissNotification(id);
          }}
        >
          <XIcon className="size-3.5" aria-hidden />
        </Button>
      </Tip>
    </span>
  );
}

/** "4m", "2h", "3d" since it arrived; "now" under a minute. */
function Age({ at }: { at: number | null }) {
  const age = useNowSelect(30_000, (now) => (at === null ? "" : formatAge(at, now, { minutes: true, hours: true, days: true, ago: false })));
  if (!age) return null;
  return (
    <span className="ml-auto pl-2 text-caption-sm tabular-nums" data-testid="notification-age">
      {age}
    </span>
  );
}

/** The thread a notification names, as a link to its tab in its own space; nothing once the thread is gone. */
function ThreadLink({ threadId }: { threadId: string }) {
  const name = useThreadsStore((s) => s.byId[threadId]?.name);
  if (name === undefined) return null;
  return (
    <button
      type="button"
      className="mt-1 flex max-w-full min-w-0 items-center gap-1 text-left text-caption text-link outline-none focus-visible:underline"
      data-testid="notification-thread"
      data-thread-id={threadId}
      onClick={() => {
        goToNotificationThread(threadId);
      }}
    >
      <MessageSquare className="size-3 shrink-0" aria-hidden />
      <Tip label={name} whenTruncated>
        <span className="min-w-0 truncate">{name || "Untitled thread"}</span>
      </Tip>
    </button>
  );
}

export interface NotificationCardOptions {
  className?: string;
  /** Leave out the link to the thread it names: the card it sits in is about that thread. */
  hideThread?: boolean;
  /** The snooze menu opened or shut. */
  onMenuOpenChange?: (open: boolean) => void;
}

/**
 * One notification (docs/notes/notifications-3-bell.md): the level's icon and the source in the
 * level's tone, its age, the host's Snooze and Dismiss; the title, the body, the thread it names
 * as a link; then the plugin's buttons (up to three, the first the primary), each running
 * notification.act with its number. A time-sensitive one is tinted. The bell's list draws it, and
 * so does a thread row's hover card, there with `hideThread` (the card is that thread's already;
 * docs/notes/notifications-4-row-mark.md). `onMenuOpenChange` hears the snooze menu open and
 * shut: the row's card stays open while its menu is up.
 */
export function NotificationCard({ notification: n, className, hideThread = false, onMenuOpenChange }: { notification: NotificationView } & NotificationCardOptions) {
  const plugin = usePlugin(n.source);
  const level = LEVEL[n.level];
  const Icon = level.icon;
  return (
    <div
      className={cn("flex flex-col px-3 py-2.5", n.timeSensitive && "bg-cf-warning-surface", className)}
      data-testid="notification-card"
      data-notification-id={n.id}
      data-level={n.level}
      data-time-sensitive={n.timeSensitive || undefined}
    >
      <div className={cn("flex h-5 min-w-0 items-center gap-1.5 text-caption-sm font-medium", level.tone)}>
        <Icon className="size-3.5 shrink-0" aria-label={level.word} />
        <span className="min-w-0 truncate" data-testid="notification-source">
          {sourceLabel(n.source, plugin?.displayName)}
        </span>
        <Age at={n.arrivedAtMs} />
        <CornerButtons id={n.id} onMenuOpenChange={onMenuOpenChange} />
      </div>
      <div className="mt-0.5 text-body font-medium [overflow-wrap:anywhere]" data-testid="notification-title">
        {n.title}
      </div>
      {n.body && (
        <div className="mt-0.5 text-caption whitespace-pre-line [overflow-wrap:anywhere]" data-testid="notification-body">
          {n.body}
        </div>
      )}
      {n.threadId && !hideThread && <ThreadLink threadId={n.threadId} />}
      {n.actions.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5" data-testid="notification-actions">
          {n.actions.map((a, i) => (
            <Button
              key={`${String(i)}:${a.label}`}
              variant={i === 0 ? "default" : "outline"}
              size="xs"
              data-testid="notification-action"
              data-primary={i === 0 || undefined}
              onClick={() => {
                void actOnNotification(n.id, i, a.label);
              }}
            >
              {a.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The card for a notification by id, from the store; nothing once it left. */
export function NotificationItem({ id, ...options }: { id: string } & NotificationCardOptions) {
  const n = useNotification(id);
  return n ? <NotificationCard notification={n} {...options} /> : null;
}
