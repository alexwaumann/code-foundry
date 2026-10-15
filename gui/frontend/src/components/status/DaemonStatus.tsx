import { Tip } from "@/components/ui/tooltip";
import { formatUptime } from "@/lib/format";
import { displayVersion } from "@/lib/update";
import { cn } from "@/lib/utils";
import { useEventsStore } from "@/stores/events";
import { useHealthStore } from "@/stores/health";

const dot = {
  connecting: "bg-warning",
  ok: "bg-success",
  error: "bg-destructive",
} as const;

/** "events" while the shared events stream is not open (connecting or reconnecting). */
function useDegradedStreams(): string {
  return useEventsStore((s) => (s.stream !== "open" ? "events" : ""));
}

/**
 * Daemon pid/version/uptime from HealthService.Ping, in the sidebar's status row. A
 * narrow sidebar clips the trailing details; the tooltip carries all of them then.
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
  const details = [label, pid !== undefined && `pid ${String(pid)}`, version, uptime !== undefined && `up ${formatUptime(uptime)}`, status === "error" && error]
    .filter(Boolean)
    .join(" · ");

  // The details while the row clips them, and always for an error (the row shows no message).
  return (
    <Tip label={details} whenTruncated={status !== "error"} align="start">
      <div className="flex min-w-0 items-center gap-2.5 overflow-hidden whitespace-nowrap" data-testid="daemon-status">
        {status === "ok" && degraded && <span className="shrink-0 text-warning">syncing {degraded}…</span>}
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
    </Tip>
  );
}
