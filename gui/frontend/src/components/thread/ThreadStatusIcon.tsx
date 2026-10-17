import { Bot, Circle, CircleX, Loader2 } from "lucide-react";
import { badgeLabels, threadBadge } from "@/lib/thread";
import { cn } from "@/lib/utils";
import { useThreadsStore } from "@/stores/threads";

/**
 * Session status badge: busy spinner (Claude starting for a message included), idle dot,
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
      return <Loader2 className={cn("size-3.5 shrink-0 animate-spin text-info", className)} {...common} />;
    case "attention":
      return (
        <span className={cn("relative flex size-2.5 shrink-0", className)} {...common}>
          <span className="absolute inline-flex size-full animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full bg-warning opacity-50" />
          <span className="relative inline-flex size-2.5 rounded-full bg-warning" />
        </span>
      );
    case "error":
      return <CircleX className={cn("size-3.5 shrink-0 text-destructive", className)} {...common} />;
    case "idle":
      return <Circle className={cn("size-2.5 shrink-0 fill-success text-success", className)} {...common} />;
    default:
      return <Bot className={cn("size-3.5 shrink-0 text-muted-foreground", className)} {...common} />;
  }
}
