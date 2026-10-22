import { useEffect, useState } from "react";
import { pluginLogs, type PluginLogLineView } from "@/api/plugin";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { errorMessage } from "@/api/stream";
import { cn } from "@/lib/utils";
import { tildify } from "@/lib/path";

function clock(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  return d.toTimeString().slice(0, 8);
}

/**
 * The tail of a plugin's log (stderr, its log lines and the daemon's own lines about it),
 * re-read every 2 s while open. The file's path is under it.
 */
export function LogsDialog({ plugin, displayName, onClose }: { plugin: string; displayName: string; onClose: () => void }) {
  const [lines, setLines] = useState<PluginLogLineView[]>([]);
  const [path, setPath] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    const load = () => {
      pluginLogs(plugin, 300, ctl.signal)
        .then((r) => {
          setLines(r.lines);
          setPath(r.path);
          setError(null);
        })
        .catch((err: unknown) => {
          if (!ctl.signal.aborted) setError(errorMessage(err));
        });
    };
    load();
    const t = setInterval(load, 2000);
    return () => {
      ctl.abort();
      clearInterval(t);
    };
  }, [plugin]);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="flex max-h-[80vh] max-w-3xl flex-col gap-3 p-5" data-testid="plugin-logs">
        <div className="space-y-0.5">
          <DialogTitle>{displayName} log</DialogTitle>
          <DialogDescription className="font-mono text-caption-sm break-all">{path ? tildify(path) : "…"}</DialogDescription>
        </div>
        {error && <p className="text-caption-sm text-cf-error">{error}</p>}
        <div className="min-h-40 flex-1 overflow-auto rounded-md border border-cf-border bg-cf-surface-sunken/40 px-2 py-1.5 font-mono text-caption-sm select-text" data-testid="plugin-logs-lines">
          {lines.length === 0 && !error && <p className="text-cf-text-muted">Nothing logged yet.</p>}
          {lines.map((l) => (
            <div key={l.seq} className={cn("flex gap-2 whitespace-pre-wrap", l.level === "error" ? "text-cf-error" : l.level === "warn" ? "text-cf-warning" : "text-cf-text")}>
              <span className="shrink-0 text-cf-text-muted tabular-nums">{clock(l.timeMs)}</span>
              <span className="w-16 shrink-0 text-cf-text-muted">{l.source === "log" ? `log ${l.level}` : l.source}</span>
              <span className="min-w-0 break-words">{l.text}</span>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
