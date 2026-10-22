import { Tip } from "@/components/ui/tooltip";
import { formatUptime } from "@/lib/format";
import { displayVersion } from "@/lib/update";
import { cn } from "@/lib/utils";
import { useEventsStore } from "@/stores/events";
import { useHealthStore } from "@/stores/health";

const dot = {
  connecting: "bg-cf-warning",
  ok: "bg-cf-success",
  error: "bg-cf-error",
} as const;

/** "events" while the shared events stream is not open (connecting or reconnecting). */
function useDegradedStreams(): string {
  return useEventsStore((s) => (s.stream !== "open" ? "events" : ""));
}

/**
 * The daemon in the sidebar's status row: a status dot and its version (from
 * HealthService.Ping). The tooltip carries the rest: the status in words, the pid, the
 * uptime and, when unreachable, the error.
 */
export function DaemonStatus() {
  const status = useHealthStore((s) => s.status);
  const pid = useHealthStore((s) => s.health?.pid);
  const rawVersion = useHealthStore((s) => s.health?.version);
  const version = rawVersion && displayVersion(rawVersion);
  const uptime = useHealthStore((s) => s.health?.uptimeSeconds);
  const error = useHealthStore((s) => s.error);
  const degraded = useDegradedStreams();
  const label = status === "ok" ? "daemon" : status === "error" ? "daemon unreachable" : "connecting";
  const details = [label, pid !== undefined && `pid ${String(pid)}`, uptime !== undefined && `up ${formatUptime(uptime)}`, status === "error" && error]
    .filter(Boolean)
    .join(" · ");

  return (
    <Tip label={details} align="start">
      <div className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap" data-testid="daemon-status" aria-label={details}>
        <span className={cn("size-2 shrink-0 rounded-full", dot[status])} data-testid="status" data-status={status} aria-hidden />
        {version && <span data-testid="version">{version}</span>}
        {status === "ok" && degraded && <span className="shrink-0 text-cf-warning">syncing {degraded}…</span>}
      </div>
    </Tip>
  );
}
