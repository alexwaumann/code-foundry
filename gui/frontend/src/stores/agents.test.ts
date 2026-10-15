import { describe, expect, it } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { ThreadEventView } from "@/api/thread";
import { applyThreadEvent } from "./thread";

function run(id: string, o: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id,
    toolUseId: "",
    parentId: "",
    description: id,
    agentType: "Explore",
    model: "",
    effort: "",
    background: false,
    spawnDepth: 1,
    status: "running",
    activity: "",
    lastTool: "",
    totalTokens: 0,
    toolUses: 0,
    durationMs: 0,
    summary: "",
    error: "",
    startedAtMs: 1,
    resumedAtMs: null,
    endedAtMs: null,
    noteItemId: "",
    ...o,
  };
}

const snapshot = (seq: number, agents: AgentRunView[]): ThreadEventView => ({ kind: "snapshot", sessionId: "s", seq, items: [], pending: [], mcp: null, commands: [], agents });
const agentsEv = (seq: number, agents: AgentRunView[]): ThreadEventView => ({ kind: "agents", sessionId: "s", seq, agents });

describe("the thread log's agents", () => {
  it("the snapshot sets them; an agents event replaces them, sharing unchanged runs", () => {
    const log = applyThreadEvent(undefined, snapshot(1, [run("a"), run("b")]));
    expect(log?.agents.map((r) => r.id)).toEqual(["a", "b"]);
    const next = applyThreadEvent(log, agentsEv(2, [run("a"), run("b", { activity: "Reading" })]));
    expect(next?.seq).toBe(2);
    expect(next?.agents[0]).toBe(log?.agents[0]);
    expect(next?.agents[1]?.activity).toBe("Reading");
    // Nothing changed: the same list.
    const same = applyThreadEvent(next, agentsEv(3, [run("a"), run("b", { activity: "Reading" })]));
    expect(same?.agents).toBe(next?.agents);
  });

  it("drops a stale event and keeps runs across a resync snapshot", () => {
    const log = applyThreadEvent(undefined, snapshot(5, [run("a")]));
    expect(applyThreadEvent(log, agentsEv(4, []))).toBe(log);
    const resync = applyThreadEvent(log, snapshot(9, [run("a")]));
    expect(resync?.agents).toBe(log?.agents);
  });
});
