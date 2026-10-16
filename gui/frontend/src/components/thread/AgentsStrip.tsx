import { Bot, ChevronRight, SquareTerminal } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { backgroundLabel } from "@/lib/agents";
import { useStripParts } from "@/stores/agents";
import { useSessionsStore } from "@/stores/sessions";

const STRIP =
  "agents-strip flex min-w-0 items-center gap-2.5 rounded-lg border border-info/35 bg-info/[0.07] py-[7px] pr-2 pl-3 text-body-sm";
const ICON = "size-3.5 shrink-0 text-info";
const LABEL = "shrink-0 font-medium whitespace-nowrap text-info";

/**
 * The sky-tinted bar above the composer while the thread's work keeps running after its
 * turn (docs/notes/agents-2-gui.md, docs/notes/background-shells.md): one sentence
 * ("2 agents and 1 shell running in the background"). With background subagents it also
 * names them ("name · activity") and offers "Agents ›" (view.panel.agents); with shells
 * only it is the sentence alone, behind a terminal icon. Shown only while
 * Session.background_agents_running or background_shells_running is above 0 and the
 * thread is not archived: foreground runs are covered by their spinning timeline rows.
 */
export function AgentsStrip({ sessionId }: { sessionId: string }) {
  const agents = useSessionsStore((s) => {
    const x = s.byId[sessionId];
    return x && x.archivedAtMs === null ? x.backgroundAgentsRunning : 0;
  });
  const shells = useSessionsStore((s) => {
    const x = s.byId[sessionId];
    return x && x.archivedAtMs === null ? x.backgroundShellsRunning : 0;
  });
  if (agents > 0) return <Strip sessionId={sessionId} agents={agents} shells={shells} />;
  if (shells > 0) return <ShellsStrip shells={shells} />;
  return null;
}

function Strip({ sessionId, agents, shells }: { sessionId: string; agents: number; shells: number }) {
  const parts = useStripParts(sessionId);
  return (
    <div className={STRIP} role="status" data-testid="agents-strip" data-kind="agents">
      <Bot className={ICON} aria-hidden />
      <span className={LABEL} data-testid="agents-strip-count">
        {backgroundLabel(agents, shells)}
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
        className="ml-auto h-6 shrink-0 gap-1 px-1.5 font-medium text-info hover:bg-info/10 hover:text-info dark:hover:bg-info/15"
        data-testid="agents-strip-open"
      >
        Agents
        <ChevronRight className="size-3" aria-hidden />
      </CommandButton>
    </div>
  );
}

function ShellsStrip({ shells }: { shells: number }) {
  return (
    <div className={STRIP} role="status" data-testid="agents-strip" data-kind="shells">
      <SquareTerminal className={ICON} aria-hidden />
      <span className={LABEL} data-testid="agents-strip-count">
        {backgroundLabel(0, shells)}
      </span>
    </div>
  );
}
