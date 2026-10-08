import { Bot, Circle, Loader2, Unplug } from "lucide-react";
import { badgeLabels, sessionBadge } from "@/lib/session";
import { cn } from "@/lib/utils";
import { useSessionsStore } from "@/stores/sessions";

/**
 * Session status badge: busy spinner, idle dot, needs-attention accent with a subtle
 * pulse; starting/closing spin muted; disconnected shows an unplugged icon.
 */
export function SessionStatusIcon({ id, className }: { id: string; className?: string }) {
  const badge = useSessionsStore((s) => sessionBadge(s.byId[id]));
  const common = { "aria-label": badgeLabels[badge], "data-session-badge": badge, role: "img" } as const;
  switch (badge) {
    case "disconnected":
      return <Unplug className={cn("size-3.5 shrink-0 text-muted-foreground", className)} {...common} />;
    case "starting":
    case "closing":
      return <Loader2 className={cn("size-3.5 shrink-0 animate-spin text-muted-foreground", className)} {...common} />;
    case "busy":
      return <Loader2 className={cn("size-3.5 shrink-0 animate-spin text-sky-400", className)} {...common} />;
    case "attention":
      return (
        <span className={cn("relative flex size-2.5 shrink-0", className)} {...common}>
          <span className="absolute inline-flex size-full animate-[ping_2s_cubic-bezier(0,0,0.2,1)_infinite] rounded-full bg-amber-400 opacity-50" />
          <span className="relative inline-flex size-2.5 rounded-full bg-amber-400" />
        </span>
      );
    case "idle":
      return <Circle className={cn("size-2.5 shrink-0 fill-emerald-400 text-emerald-400", className)} {...common} />;
    default:
      return <Bot className={cn("size-3.5 shrink-0 text-muted-foreground", className)} {...common} />;
  }
}
