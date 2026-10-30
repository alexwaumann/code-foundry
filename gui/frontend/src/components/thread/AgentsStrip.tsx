import { Bot } from "lucide-react";
import { agentName, backgroundLabel, stripPart } from "@/lib/agents";
import { useAgentRun, useStripRunIds } from "@/stores/agents";
import { openAgentRun, useCanOpenAgents } from "@/stores/subagentActions";
import { useThreadsStore } from "@/stores/threads";

const STRIP =
  "agents-strip flex min-w-0 items-center gap-2.5 rounded-lg border border-cf-info/35 bg-cf-info/[0.07] py-[7px] pr-2 pl-3 text-body-sm";
const ICON = "size-3.5 shrink-0 text-cf-info-text";
const LABEL = "shrink-0 font-medium whitespace-nowrap text-cf-info-text";

/**
 * The sky-tinted bar above the composer while the thread's background subagents keep
 * running after its turn (docs/notes/agents-2-gui.md): "2 agents running in the
 * background", then each run as "name · activity". Shown only while
 * Thread.background_agents_running is above 0 and the thread is not archived: foreground
 * runs are covered by their spinning timeline rows, and background shells by the thread
 * info card's Shells group (docs/notes/thread-header-crumb.md).
 */
export function AgentsStrip({ threadId }: { threadId: string }) {
  const agents = useThreadsStore((s) => {
    const x = s.byId[threadId];
    return x && x.archivedAtMs === null ? x.backgroundAgentsRunning : 0;
  });
  return agents > 0 ? <Strip threadId={threadId} agents={agents} /> : null;
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

function Strip({ threadId, agents }: { threadId: string; agents: number }) {
  const ids = useStripRunIds(threadId);
  return (
    <div className={STRIP} role="status" data-testid="agents-strip" data-kind="agents">
      <Bot className={ICON} aria-hidden />
      <span className={LABEL} data-testid="agents-strip-count">
        {backgroundLabel(agents)}
      </span>
      <span className="min-w-0 flex-1 truncate text-cf-text-muted" data-testid="agents-strip-runs">
        {ids.map((id, i) => (
          <StripRun key={id} threadId={threadId} id={id} first={i === 0} />
        ))}
      </span>
    </div>
  );
}
