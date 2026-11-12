import { threadBadge, type ThreadBadge } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";

/** The dot's colour per status: working is the accent, needs you the warning, an error the error; idle is quiet. */
const TONE: Readonly<Record<ThreadBadge, string>> = {
  busy: "bg-cf-accent",
  attention: "bg-cf-warning",
  error: "bg-cf-error",
  idle: "bg-cf-text-muted/60",
  unknown: "bg-cf-text-muted/60",
};

/**
 * The small dot before a thread's name where a linked surface names it (the row under the
 * strip, the "+" menu's thread item): its status at a glance. Decorative: the status is the
 * sidebar's and the thread's own to say.
 */
export function ThreadDot({ threadId, className }: { threadId: string; className?: string }) {
  const badge = useThreadsStore((s) => threadBadge(s.byId[threadId]));
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", TONE[badge], className)} data-testid="thread-dot" data-badge={badge} />;
}
