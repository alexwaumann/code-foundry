import { ChevronRight } from "lucide-react";
import { openAgentRun, useCanOpenAgents } from "@/stores/subagentActions";

/**
 * "Open ›": opens one of a thread's own subagent runs in the read-only subagent view
 * (thread.agent.open). A small outlined button on an Agent row of the timeline and on the
 * daemon's "Agent finished / failed" note, shown while its row is hovered or the button
 * has the keyboard (thread.css `.agent-open`). Nothing where the command is not listed.
 */
export function AgentOpen({ threadId, runId, name, testId = "thread-agent-open" }: { threadId: string; runId: string; name: string; testId?: string }) {
  const can = useCanOpenAgents();
  if (!can) return null;
  return (
    <button
      type="button"
      className="agent-open"
      aria-label={`Open ${name}`}
      data-testid={testId}
      data-run={runId}
      onClick={(e) => {
        e.stopPropagation();
        void openAgentRun(threadId, runId);
      }}
    >
      Open
      <ChevronRight aria-hidden />
    </button>
  );
}
