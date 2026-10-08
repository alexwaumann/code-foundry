import { formatUptime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useHealthStore } from "@/stores/health";
import { useIntentsStore } from "@/stores/intents";
import { useReposStore } from "@/stores/repos";
import { useTerminalsStore } from "@/stores/terminals";

const dot = {
  connecting: "bg-yellow-500",
  ok: "bg-emerald-500",
  error: "bg-red-500",
} as const;

/** Streams that are not open, e.g. "terminals" while reconnecting. */
function useDegradedStreams(): string {
  const t = useTerminalsStore((s) => s.stream !== "open");
  const r = useReposStore((s) => s.stream !== "open");
  const i = useIntentsStore((s) => s.stream !== "open");
  return [t && "terminals", r && "repos", i && "intents"].filter(Boolean).join(", ");
}

/** Daemon pid/version/uptime from HealthService.Ping (moved from the Phase 0 panel). */
export function DaemonStatus() {
  const status = useHealthStore((s) => s.status);
  const pid = useHealthStore((s) => s.health?.pid);
  const version = useHealthStore((s) => s.health?.version);
  const uptime = useHealthStore((s) => s.health?.uptimeSeconds);
  const error = useHealthStore((s) => s.error);
  const degraded = useDegradedStreams();

  return (
    <div className="flex min-w-0 items-center gap-3" data-testid="daemon-status">
      {status === "ok" && degraded && (
        <span className="truncate text-amber-400" title={`Not streaming: ${degraded}`}>
          syncing {degraded}…
        </span>
      )}
      <span className="flex items-center gap-1.5" title={status === "error" ? (error ?? "") : "daemon"}>
        <span className={cn("size-2 rounded-full", dot[status])} aria-hidden />
        <span data-testid="status">{status === "ok" ? "daemon" : status === "error" ? "daemon unreachable" : "connecting"}</span>
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
