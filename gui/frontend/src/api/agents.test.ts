import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { SessionSchema } from "@/gen/codefoundry/v1/session_pb";
import { ThreadAgentRunSchema, ThreadAgentStatus, ThreadEventSchema } from "@/gen/codefoundry/v1/thread_pb";
import { toAgentRunView } from "./agents";
import { toSessionView } from "./session";
import { toThreadEventView } from "./thread";

describe("toAgentRunView", () => {
  it("maps every field", () => {
    const v = toAgentRunView(
      create(ThreadAgentRunSchema, {
        id: "a1",
        toolUseId: "toolu_1",
        parentId: "a0",
        description: "PR 1",
        agentType: "general-purpose",
        model: "opus",
        effort: "high",
        background: true,
        spawnDepth: 2,
        status: ThreadAgentStatus.RUNNING,
        activity: "Running go test",
        lastTool: "Bash",
        totalTokens: 48_200n,
        toolUses: 23n,
        durationMs: 9_000n,
        summary: "",
        error: "",
        startedAt: timestampFromMs(1000),
        resumedAt: timestampFromMs(2000),
        noteItemId: "n1",
      }),
    );
    expect(v).toEqual({
      id: "a1",
      toolUseId: "toolu_1",
      parentId: "a0",
      description: "PR 1",
      agentType: "general-purpose",
      model: "opus",
      effort: "high",
      background: true,
      spawnDepth: 2,
      status: "running",
      activity: "Running go test",
      lastTool: "Bash",
      totalTokens: 48_200,
      toolUses: 23,
      durationMs: 9_000,
      summary: "",
      error: "",
      startedAtMs: 1000,
      resumedAtMs: 2000,
      endedAtMs: null,
      noteItemId: "n1",
    });
  });

  it.each([
    [ThreadAgentStatus.RUNNING, "running"],
    [ThreadAgentStatus.DONE, "done"],
    [ThreadAgentStatus.FAILED, "failed"],
    [ThreadAgentStatus.UNSPECIFIED, "unknown"],
  ])("status %i is %s", (status, want) => {
    expect(toAgentRunView(create(ThreadAgentRunSchema, { id: "x", status })).status).toBe(want);
  });
});

describe("the Watch's agents", () => {
  it("the snapshot carries the list in spawn order", () => {
    const ev = toThreadEventView(
      create(ThreadEventSchema, { event: { case: "snapshot", value: { sessionId: "s", seq: 3n, agents: [{ id: "a0", status: ThreadAgentStatus.DONE }, { id: "a1", status: ThreadAgentStatus.RUNNING }] } } }),
    );
    expect(ev?.kind).toBe("snapshot");
    expect(ev?.kind === "snapshot" && ev.agents.map((a) => [a.id, a.status])).toEqual([
      ["a0", "done"],
      ["a1", "running"],
    ]);
  });

  it("an agents event carries the whole new list", () => {
    const ev = toThreadEventView(create(ThreadEventSchema, { event: { case: "agents", value: { sessionId: "s", seq: 9n, agents: [{ id: "a1", status: ThreadAgentStatus.FAILED, error: "stopped" }] } } }));
    expect(ev).toMatchObject({ kind: "agents", sessionId: "s", seq: 9 });
    expect(ev?.kind === "agents" && ev.agents[0]).toMatchObject({ id: "a1", status: "failed", error: "stopped" });
  });
});

describe("the session's running agents", () => {
  it("maps both counts", () => {
    const v = toSessionView(create(SessionSchema, { id: "s", agentsRunning: 3, backgroundAgentsRunning: 2 }));
    expect([v.agentsRunning, v.backgroundAgentsRunning]).toEqual([3, 2]);
  });

  it("maps the background shells", () => {
    expect(toSessionView(create(SessionSchema, { id: "s", backgroundShellsRunning: 2 })).backgroundShellsRunning).toBe(2);
    expect(toSessionView(create(SessionSchema, { id: "s" })).backgroundShellsRunning).toBe(0);
  });
});
