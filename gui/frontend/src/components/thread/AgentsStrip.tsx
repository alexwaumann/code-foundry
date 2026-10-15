import { Bot, ChevronRight } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { agentsLabel } from "@/lib/agents";
import { useStripParts } from "@/stores/agents";
import { useSessionsStore } from "@/stores/sessions";

/**
 * The sky-tinted bar above the composer while the thread's background subagents keep
 * running (docs/sketches/agents-panel, `thread-strip`; docs/notes/agents-2-gui.md): how
 * many, then "name · activity" for each, and "Agents ›" (view.panel.agents) on the right.
 * Shown only while Session.background_agents_running > 0 and the thread is not archived:
 * foreground runs are covered by their spinning timeline rows.
 */
export function AgentsStrip({ sessionId }: { sessionId: string }) {
  const count = useSessionsStore((s) => {
    const x = s.byId[sessionId];
    return x && x.archivedAtMs === null ? x.backgroundAgentsRunning : 0;
  });
  if (count <= 0) return null;
  return <Strip sessionId={sessionId} count={count} />;
}

function Strip({ sessionId, count }: { sessionId: string; count: number }) {
  const parts = useStripParts(sessionId);
  return (
    <div
      className="agents-strip flex min-w-0 items-center gap-2.5 rounded-[10px] border border-sky-500/35 bg-sky-500/[0.07] py-[7px] pr-2 pl-3 text-[12.5px] text-foreground"
      role="status"
      data-testid="agents-strip"
    >
      <Bot className="size-3.5 shrink-0 text-sky-600 dark:text-sky-400" aria-hidden />
      <span className="shrink-0 font-medium whitespace-nowrap text-sky-700 dark:text-sky-300" data-testid="agents-strip-count">
        {agentsLabel(count)} running in the background
      </span>
      <span className="min-w-0 flex-1 truncate text-muted-foreground" data-testid="agents-strip-runs">
        {parts.map((p, i) => (
          <span key={`${String(i)}:${p}`}>
            {i > 0 && <span className="inline-block w-4" aria-hidden />}
            {p}
          </span>
        ))}
      </span>
      <CommandButton
        command="view.panel.agents"
        whenUnavailable="hide"
        variant="ghost"
        size="xs"
        className="ml-auto h-6 shrink-0 gap-1 px-1.5 font-medium text-sky-600 hover:bg-sky-500/10 hover:text-sky-700 dark:text-sky-400 dark:hover:bg-sky-500/15 dark:hover:text-sky-300"
        data-testid="agents-strip-open"
      >
        Agents
        <ChevronRight className="size-3" aria-hidden />
      </CommandButton>
    </div>
  );
}
