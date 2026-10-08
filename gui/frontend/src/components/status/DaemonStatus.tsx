import { formatUptime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useEventsStore } from "@/stores/events";
import { useHealthStore } from "@/stores/health";

const dot = {
  connecting: "bg-yellow-500",
  ok: "bg-emerald-500",
  error: "bg-red-500",
} as const;

/** "events" while the shared events stream is not open (connecting or reconnecting). */
function useDegradedStreams(): string {
  return useEventsStore((s) => (s.stream !== "open" ? "events" : ""));
}

/**
 * Daemon pid/version/uptime from HealthService.Ping, in the sidebar's status row. A
 * narrow sidebar clips the trailing details; the tooltip carries all of them.
 */
export function DaemonStatus() {
  const status = useHealthStore((s) => s.status);
  const pid = useHealthStore((s) => s.health?.pid);
  const version = useHealthStore((s) => s.health?.version);
  const uptime = useHealthStore((s) => s.health?.uptimeSeconds);
  const error = useHealthStore((s) => s.error);
  const degraded = useDegradedStreams();
  const label = status === "ok" ? "daemon" : status === "error" ? "daemon unreachable" : "connecting";
  const details = [label, pid !== undefined && `pid ${String(pid)}`, version, uptime !== undefined && `up ${formatUptime(uptime)}`, status === "error" && error]
    .filter(Boolean)
    .join(" · ");

  return (
    <div className="flex min-w-0 items-center gap-2.5 overflow-hidden whitespace-nowrap" data-testid="daemon-status" title={details}>
      {status === "ok" && degraded && (
        <span className="shrink-0 text-amber-400" title={`Not streaming: ${degraded}`}>
          syncing {degraded}…
        </span>
      )}
      <span className="flex shrink-0 items-center gap-1.5">
        <span className={cn("size-2 rounded-full", dot[status])} aria-hidden />
        <span data-testid="status">{label}</span>
      </span>
      {pid !== undefined && (
        <span className="tabular-nums">
          pid <span data-testid="pid">{pid}</span>
        </span>
      )}
      {version && <span data-testid="version">{version}</span>}
      {uptime !== undefined && (
        <span className="tabular-nums">
          up <span data-testid="uptime">{formatUptime(uptime)}</span>
        </span>
      )}
    </div>
  );
}
