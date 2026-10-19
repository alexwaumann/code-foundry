import { Plug } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { Tip } from "@/components/ui/tooltip";
import { envStaleTip } from "@/lib/envStale";
import { useThreadsStore } from "@/stores/threads";

/**
 * A muted line in the thread's header when a plugin's session environment changed since
 * the thread's Claude process started (Thread.plugin_env_stale;
 * docs/notes/plugins-env-restart.md): "Plugin environment changed · Restart to apply".
 * Restart is thread.restart (its confirmation when a turn is running says the turn is
 * interrupted and the conversation continues); the tooltip names what changed. Nothing
 * while the process is current or not running.
 */
export function EnvStaleNote({ id }: { id: string }) {
  const change = useThreadsStore((s) => {
    const t = s.byId[id];
    return t?.pluginEnvStale ? (t.pluginEnvChange ?? "") : null;
  });
  if (change === null) return null;
  return (
    <span className="flex min-w-0 shrink-[2] items-center gap-1 text-caption-sm text-muted-foreground" data-testid="thread-env-stale">
      <Tip label={envStaleTip(change)} data-testid="thread-env-stale-tip">
        <span className="flex min-w-0 items-center gap-[5px]" data-testid="thread-env-stale-text">
          <Plug className="size-3 shrink-0" aria-hidden />
          <span className="min-w-0 truncate">Plugin environment changed</span>
        </span>
      </Tip>
      <span className="shrink-0" aria-hidden>
        ·
      </span>
      <CommandButton
        command="thread.restart"
        label="Restart"
        variant="link"
        size="xs"
        className="h-auto shrink-0 px-0 text-caption-sm font-medium text-foreground"
        data-testid="thread-env-stale-restart"
      />
      <span className="shrink-0">to apply</span>
    </span>
  );
}
