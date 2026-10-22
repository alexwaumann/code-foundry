import { Bot, Circle, CircleX, Loader2 } from "lucide-react";
import { badgeLabels, threadBadge } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";

/**
 * Thread status badge: busy spinner (Claude starting for a message included), idle dot,
 * needs-attention accent with a subtle pulse, error (the process ended mid-turn:
 * interrupted) a red crossed circle. Whether the process runs never shows (threadBadge).
 * The sidebar's thread rows do not use it (they say the status in words, lib/statusLine);
 * ThreadLink and ThreadParts do.
 */
export function ThreadStatusIcon({ id, className }: { id: string; className?: string }) {
  const badge = useThreadsStore((s) => threadBadge(s.byId[id]));
  const common = { "aria-label": badgeLabels[badge], "data-thread-badge": badge, role: "img" } as const;
  switch (badge) {
    case "busy":
      return <Loader2 className={cn("size-3.5 shrink-0 animate-spin text-cf-info-text", className)} {...common} />;
    case "attention":
      return (
        <span className={cn("relative flex size-2.5 shrink-0", className)} {...common}>
          <span className="absolute inline-flex size-full animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full bg-cf-warning opacity-50" />
          <span className="relative inline-flex size-2.5 rounded-full bg-cf-warning" />
        </span>
      );
    case "error":
      return <CircleX className={cn("size-3.5 shrink-0 text-cf-error-text", className)} {...common} />;
    case "idle":
      return <Circle className={cn("size-2.5 shrink-0 fill-cf-success text-cf-success-text", className)} {...common} />;
    default:
      return <Bot className={cn("size-3.5 shrink-0 text-cf-text-muted", className)} {...common} />;
  }
}
