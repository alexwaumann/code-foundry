/**
 * Narrow selectors over a thread's subagent runs (docs/notes/agents-2-gui.md). The runs
 * live on the thread store's log (`ThreadLog.agents`, fed by the thread's Watch, open
 * whenever the thread is selected); unchanged runs keep their identity (lib/agents
 * shareAgents), so a progress update re-renders only the row, strip or timeline row of the
 * run that moved. The list's order selector is shallow over ids: it changes only when a run
 * starts or the nesting changes.
 */
import { useShallow } from "zustand/react/shallow";
import type { AgentRunView } from "@/api/agents";
import { agentCounts, agentRows, stripPart, stripRuns } from "@/lib/agents";
import { useThreadStore } from "./thread";

const NO_IDS: readonly string[] = [];

/** The list's run ids in order (lib/agents agentRows): spawn order, nested runs under their parent. */
export function useAgentRowIds(threadId: string): readonly string[] {
  return useThreadStore(useShallow((s) => (s.logs[threadId] ? agentRows(s.logs[threadId].agents).map((r) => r.id) : NO_IDS)));
}

/** A run's nesting level in the list: 0 for the thread's own. */
export function useAgentLevel(threadId: string, id: string): number {
  return useThreadStore((s) => {
    const runs = s.logs[threadId]?.agents;
    return runs ? (agentRows(runs).find((r) => r.id === id)?.level ?? 0) : 0;
  });
}

/** One run (narrow: re-renders only when that run changes). */
export function useAgentRun(threadId: string, id: string): AgentRunView | undefined {
  return useThreadStore((s) => s.logs[threadId]?.agents.find((r) => r.id === id));
}

/** The run an Agent call (by its tool_use id, which is its item id) spawned, if the daemon follows it. */
export function useAgentRunOfCall(threadId: string, toolUseId: string): AgentRunView | undefined {
  return useThreadStore((s) => (toolUseId ? s.logs[threadId]?.agents.find((r) => r.toolUseId === toolUseId) : undefined));
}

/** The run whose end a note item announced (its `noteItemId`), if any. */
export function useAgentRunOfNote(threadId: string, noteItemId: string): AgentRunView | undefined {
  return useThreadStore((s) => s.logs[threadId]?.agents.find((r) => r.noteItemId === noteItemId));
}

/** The header's figures (lib/agents agentCounts); null before the thread's snapshot. */
export function useAgentCounts(threadId: string): { running: number; total: number; background: number } | null {
  return useThreadStore(useShallow((s) => (s.logs[threadId] ? agentCounts(s.logs[threadId].agents) : null)));
}

/** The strip's "name · activity" parts for the running background runs. */
export function useStripParts(threadId: string): readonly string[] {
  return useThreadStore(useShallow((s) => (s.logs[threadId] ? stripRuns(s.logs[threadId].agents).map(stripPart) : NO_IDS)));
}
