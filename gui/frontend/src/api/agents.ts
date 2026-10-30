/**
 * A thread's subagent runs (docs/notes/agents-1-daemon.md, docs/notes/agents-2-gui.md)
 * mapped to view models. Generated types stay in src/api. ThreadService.WatchThread carries the
 * whole list in spawn order: the snapshot's `agents`, then an `agents` event on every
 * change, so the thread info card's agent rows, the strip above the composer and the
 * timeline's Agent rows read it from the thread store.
 */
import { timestampMs } from "@bufbuild/protobuf/wkt";
import { ThreadAgentStatus, type ThreadAgentRun } from "@/gen/codefoundry/v1/thread_pb";

export type AgentStatusView = "running" | "done" | "failed" | "unknown";

/** One subagent run (a Claude Code Agent tool call) as the daemon follows it. */
export interface AgentRunView {
  /** Claude's agent id. */
  id: string;
  /** The Agent call's tool_use id, which is its thread item's id; "" when unknown. */
  toolUseId: string;
  /** The run that spawned this one (spawn depth 2 and up); "" for the thread's own. */
  parentId: string;
  /** The Agent call's description: the run's name. */
  description: string;
  /** "general-purpose", "Explore", ... */
  agentType: string;
  /** As requested ("haiku"); "" when inherited from the thread. */
  model: string;
  effort: string;
  /** Launched in the background: the thread goes on meanwhile. */
  background: boolean;
  /** 1: spawned by the thread; 2 and up: by another run. */
  spawnDepth: number;
  status: AgentStatusView;
  /** What it is doing now (Claude's line, "Running go test ./..."); kept once it ends. */
  activity: string;
  /** Its latest tool's name. */
  lastTool: string;
  /** The tokens of its latest request. */
  totalTokens: number;
  toolUses: number;
  /** Its running time as Claude counts it (summed over its wakes). */
  durationMs: number;
  /** Its report once done. */
  summary: string;
  /** Why it failed. */
  error: string;
  /** Epoch ms; null when unknown. resumedAt: SendMessage last woke it; endedAt: it last ended. */
  startedAtMs: number | null;
  resumedAtMs: number | null;
  endedAtMs: number | null;
  /** The note item announcing a background run's end ("Agent finished · …"); "" for none. */
  noteItemId: string;
}

const statuses: Record<ThreadAgentStatus, AgentStatusView> = {
  [ThreadAgentStatus.UNSPECIFIED]: "unknown",
  [ThreadAgentStatus.RUNNING]: "running",
  [ThreadAgentStatus.DONE]: "done",
  [ThreadAgentStatus.FAILED]: "failed",
};

export function toAgentRunView(r: ThreadAgentRun): AgentRunView {
  return {
    id: r.id,
    toolUseId: r.toolUseId,
    parentId: r.parentId,
    description: r.description,
    agentType: r.agentType,
    model: r.model,
    effort: r.effort,
    background: r.background,
    spawnDepth: r.spawnDepth,
    status: r.status in statuses ? statuses[r.status] : "unknown", // a newer daemon's value
    activity: r.activity,
    lastTool: r.lastTool,
    totalTokens: Number(r.totalTokens),
    toolUses: Number(r.toolUses),
    durationMs: Number(r.durationMs),
    summary: r.summary,
    error: r.error,
    startedAtMs: r.startedAt ? timestampMs(r.startedAt) : null,
    resumedAtMs: r.resumedAt ? timestampMs(r.resumedAt) : null,
    endedAtMs: r.endedAt ? timestampMs(r.endedAt) : null,
    noteItemId: r.noteItemId,
  };
}

export function toAgentRunViews(list: readonly ThreadAgentRun[]): AgentRunView[] {
  return list.map(toAgentRunView);
}
