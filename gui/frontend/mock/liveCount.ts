/**
 * The sidebar row's live count (docs/notes/sidebar-live-count.md): the daemon's waiting
 * reason grammar and background subagent runs for the live-count scenario
 * (World.addLiveCount, POST /__mock/live-count).
 */
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ThreadAgentStatus } from "../src/gen/codefoundry/v1/thread_pb";
import type { AgentRunInit } from "./agents";

const count = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/**
 * The daemon's waiting reason (internal/store/thread waiting.go): "waiting on " + the
 * non-zero parts joined by " and ", child threads, subagents, shells in that order
 * ("waiting on 2 child threads and 1 subagent"); "waiting" alone when none is set (a
 * queued wake).
 */
export function waitingReason(p: { children?: number; subagents?: number; shells?: number }): string {
  const parts = [
    p.children ? count(p.children, "child thread", "child threads") : "",
    p.subagents ? count(p.subagents, "subagent", "subagents") : "",
    p.shells ? count(p.shells, "shell", "shells") : "",
  ].filter(Boolean);
  return parts.length === 0 ? "waiting" : `waiting on ${parts.join(" and ")}`;
}

/** A running background subagent run of the thread's own (spawn depth 1), started `min` minutes ago. */
export function backgroundRun(id: string, description: string, activity: string, min: number): AgentRunInit {
  return {
    id,
    description,
    agentType: "general-purpose",
    background: true,
    spawnDepth: 1,
    status: ThreadAgentStatus.RUNNING,
    activity,
    lastTool: "Read",
    startedAt: timestampFromDate(new Date(Date.now() - min * 60_000)),
  };
}
