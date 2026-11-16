import { Bell } from "lucide-react";
import type { ThreadMarkTone } from "@/lib/notifications";
import { rowToneClasses } from "@/lib/statusRegistry";
import { cn } from "@/lib/utils";
import { useThreadMark } from "@/stores/notifications";

/** The mark's tone as a row tone's text colour: error, the attention (warning) tone, or the row's muted one. */
const TONE: Readonly<Record<ThreadMarkTone, string>> = {
  error: rowToneClasses.error,
  warning: rowToneClasses.warning,
  muted: rowToneClasses.muted,
};

/**
 * A thread's notifications on its row (docs/notes/notifications-4-row-mark.md): a small bell and
 * how many shown notifications name the thread, beside the pull request tag and drawn like the
 * row's other counts. Nothing with none. It moves no section and changes no status word. No
 * tooltip: the row's hover card lists the notifications themselves, with their buttons; the
 * label is for screen readers.
 */
export function NotificationMark({ id }: { id: string }) {
  const { count, tone } = useThreadMark(id);
  if (count === 0) return null;
  return (
    <span
      className={cn("flex shrink-0 items-center gap-0.5 font-medium tabular-nums", TONE[tone])}
      aria-label={count === 1 ? "1 notification" : `${String(count)} notifications`}
      data-testid="row-notifications"
      data-count={count}
      data-tone={tone}
    >
      <Bell className="size-3 shrink-0" aria-hidden />
      {count}
    </span>
  );
}
