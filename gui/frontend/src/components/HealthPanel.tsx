import { Button } from "@/components/ui/button";
import { formatUptime } from "@/lib/format";
import { useHealthStore } from "@/stores/health";

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-mono text-lg">{value}</dd>
    </div>
  );
}

const statusStyles = {
  connecting: "bg-yellow-500",
  ok: "bg-emerald-500",
  error: "bg-red-500",
} as const;

export function HealthPanel() {
  const status = useHealthStore((s) => s.status);
  const pid = useHealthStore((s) => s.health?.pid);
  const version = useHealthStore((s) => s.health?.version);
  const uptime = useHealthStore((s) => s.health?.uptimeSeconds);
  const error = useHealthStore((s) => s.error);
  const refresh = useHealthStore((s) => s.refresh);

  return (
    <section className="w-full max-w-md rounded-xl border bg-card p-6 text-card-foreground shadow-sm">
      <header className="mb-6 flex items-center justify-between">
        <h2 className="flex items-center gap-2 text-lg font-semibold">
          <span className={`size-2.5 rounded-full ${statusStyles[status]}`} aria-hidden />
          Daemon
          <span className="text-sm font-normal text-muted-foreground" data-testid="status">
            {status}
          </span>
        </h2>
        <Button variant="outline" size="sm" onClick={() => void refresh()}>
          Ping
        </Button>
      </header>
      <dl className="grid grid-cols-3 gap-4">
        <Field label="pid" value={pid === undefined ? "–" : String(pid)} />
        <Field label="version" value={version ?? "–"} />
        <Field label="uptime" value={uptime === undefined ? "–" : formatUptime(uptime)} />
      </dl>
      {error && status === "error" && (
        <p className="mt-4 break-words text-sm text-destructive" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
