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
import { stripRuns } from "@/lib/agents";
import { useThreadStore } from "./thread";

const NO_IDS: readonly string[] = [];

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

/** The running background runs the strip names (lib/agents stripRuns), by id: shallow, so a progress update re-renders only that run's part. */
export function useStripRunIds(threadId: string): readonly string[] {
  return useThreadStore(useShallow((s) => (s.logs[threadId] ? stripRuns(s.logs[threadId].agents).map((r) => r.id) : NO_IDS)));
}
