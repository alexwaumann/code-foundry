import { Bot, ChevronRight, SquareTerminal } from "lucide-react";
import { CommandButton } from "@/components/command/CommandButton";
import { agentName, backgroundLabel, stripPart } from "@/lib/agents";
import { useAgentRun, useStripRunIds } from "@/stores/agents";
import { openAgentRun, useCanOpenAgents } from "@/stores/subagentActions";
import { useThreadsStore } from "@/stores/threads";

const STRIP =
  "agents-strip flex min-w-0 items-center gap-2.5 rounded-lg border border-cf-info/35 bg-cf-info/[0.07] py-[7px] pr-2 pl-3 text-body-sm";
const ICON = "size-3.5 shrink-0 text-cf-info";
const LABEL = "shrink-0 font-medium whitespace-nowrap text-cf-info";

/**
 * The sky-tinted bar above the composer while the thread's work keeps running after its
 * turn (docs/notes/agents-2-gui.md, docs/notes/background-shells.md): one sentence
 * ("2 agents and 1 shell running in the background"). With background subagents it also
 * names them ("name · activity") and offers "Agents ›" (view.panel.agents); with shells
 * only it is the sentence alone, behind a terminal icon. Shown only while
 * Thread.background_agents_running or background_shells_running is above 0 and the
 * thread is not archived: foreground runs are covered by their spinning timeline rows.
 */
export function AgentsStrip({ threadId }: { threadId: string }) {
  const agents = useThreadsStore((s) => {
    const x = s.byId[threadId];
    return x && x.archivedAtMs === null ? x.backgroundAgentsRunning : 0;
  });
  const shells = useThreadsStore((s) => {
    const x = s.byId[threadId];
    return x && x.archivedAtMs === null ? x.backgroundShellsRunning : 0;
  });
  if (agents > 0) return <Strip threadId={threadId} agents={agents} shells={shells} />;
  if (shells > 0) return <ShellsStrip shells={shells} />;
  return null;
}

/**
 * One running background run in the strip: its name, a link (dotted underline on hover)
 * that opens it in the read-only subagent view (thread.agent.open), then " · activity".
 * The name is plain text where the command is not listed.
 */
function StripRun({ threadId, id, first }: { threadId: string; id: string; first: boolean }) {
  const run = useAgentRun(threadId, id);
  const can = useCanOpenAgents();
  if (!run) return null;
  const name = agentName(run);
  const part = stripPart(run);
  const rest = part.slice(name.length);
  return (
    <span data-testid="agents-strip-run" data-agent={id}>
      {!first && <span className="inline-block w-4" aria-hidden />}
      {can ? (
        <button
          type="button"
          className="cursor-default text-cf-text/80 decoration-dotted underline-offset-2 hover:text-cf-text hover:underline focus-visible:underline focus-visible:outline-none"
          data-testid="agents-strip-name"
          onClick={() => {
            void openAgentRun(threadId, id);
          }}
        >
          {name}
        </button>
      ) : (
        name
      )}
      {rest}
    </span>
  );
}

function Strip({ threadId, agents, shells }: { threadId: string; agents: number; shells: number }) {
  const ids = useStripRunIds(threadId);
  return (
    <div className={STRIP} role="status" data-testid="agents-strip" data-kind="agents">
      <Bot className={ICON} aria-hidden />
      <span className={LABEL} data-testid="agents-strip-count">
        {backgroundLabel(agents, shells)}
      </span>
      <span className="min-w-0 flex-1 truncate text-cf-text-muted" data-testid="agents-strip-runs">
        {ids.map((id, i) => (
          <StripRun key={id} threadId={threadId} id={id} first={i === 0} />
        ))}
      </span>
      <CommandButton
        command="view.panel.agents"
        whenUnavailable="hide"
        variant="ghost"
        size="xs"
        className="ml-auto h-6 shrink-0 gap-1 px-1.5 font-medium text-cf-info hover:bg-cf-info-surface hover:text-cf-info dark:hover:bg-cf-info/15"
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
