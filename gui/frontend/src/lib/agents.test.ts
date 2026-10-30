import { describe, expect, it } from "vitest";
import type { AgentRunView } from "@/api/agents";
import {
  agentElapsedMs,
  agentName,
  agentStatusText,
  agentsLabel,
  backgroundLabel,
  fmtElapsed,
  parseAgentNote,
  sameAgent,
  shareAgents,
  stripPart,
  stripRuns,
} from "./agents";

function run(id: string, o: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id,
    toolUseId: `toolu_${id}`,
    parentId: "",
    description: `run ${id}`,
    agentType: "general-purpose",
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
    startedAtMs: 1000,
    resumedAtMs: null,
    endedAtMs: null,
    noteItemId: "",
    ...o,
  };
}

describe("labels", () => {
  it.each([
    [{ description: "PR 1", agentType: "general-purpose" }, "PR 1"],
    [{ description: "", agentType: "Explore" }, "Explore"],
    [{ description: "", agentType: "" }, "Agent"],
  ])("agentName(%o) = %s", (r, want) => {
    expect(agentName(r)).toBe(want);
  });

  it.each([
    [0, "0s"],
    [999, "0s"],
    [38_400, "38s"],
    [63_000, "1m 03s"],
    [252_000, "4m 12s"],
    [3_900_000, "1h 05m"],
  ])("fmtElapsed(%i) = %s", (ms, want) => {
    expect(fmtElapsed(ms)).toBe(want);
  });

  it.each([
    [1, "1 agent"],
    [3, "3 agents"],
  ])("agentsLabel(%i) = %s", (n, want) => {
    expect(agentsLabel(n)).toBe(want);
  });

  it.each([
    [1, "1 agent running in the background"],
    [3, "3 agents running in the background"],
    [0, ""],
  ])("backgroundLabel(%i) = %s", (agents, want) => {
    expect(backgroundLabel(agents)).toBe(want);
  });
});

describe("agentElapsedMs", () => {
  const now = 100_000;
  it.each([
    ["running: from its start", run("a", { startedAtMs: 40_000 }), 60_000],
    ["running after a wake: from the wake", run("a", { startedAtMs: 10_000, resumedAtMs: 90_000, durationMs: 30_000 }), 10_000],
    ["running, no start: Claude's duration", run("a", { startedAtMs: null, durationMs: 5_000 }), 5_000],
    ["running, nothing known", run("a", { startedAtMs: null }), null],
    ["ended: Claude's duration", run("a", { status: "done", durationMs: 12_000, endedAtMs: 99_000 }), 12_000],
    ["ended without a duration: start to end", run("a", { status: "failed", startedAtMs: 20_000, endedAtMs: 83_000 }), 63_000],
    ["ended, unknown end", run("a", { status: "done", endedAtMs: null }), null],
  ])("%s", (_n, r, want) => {
    expect(agentElapsedMs(r, now)).toBe(want);
  });
});

describe("agentStatusText", () => {
  const now = 1_000_000;
  it.each([
    [run("a"), "Running"],
    [run("a", { status: "done", endedAtMs: now - 5 * 60_000 }), "Done · 5 min ago"],
    [run("a", { status: "failed", endedAtMs: now - 10_000 }), "Failed · just now"],
    [run("a", { status: "done", endedAtMs: null }), "Done"],
  ])("%#", (r, want) => {
    expect(agentStatusText(r, now)).toBe(want);
  });
});

describe("the strip", () => {
  const runs = [
    run("a0", { status: "done" }),
    run("a1", { background: true, activity: "Running go test" }),
    run("a1b", { parentId: "a1", spawnDepth: 2, background: true }),
    run("a2", { background: true, description: "PR 2", activity: "PR 2" }),
    run("a3", { background: true, status: "failed" }),
    run("a4"),
  ];

  it("the strip names the running background runs of the thread itself", () => {
    expect(stripRuns(runs).map((r) => r.id)).toEqual(["a1", "a2"]);
    expect(stripRuns(runs).map(stripPart)).toEqual(["run a1 · Running go test", "PR 2"]);
  });
});

describe("shareAgents", () => {
  it("keeps unchanged runs by identity, and the list when nothing changed", () => {
    const prev = [run("a"), run("b")];
    const same = shareAgents(prev, [run("a"), run("b")]);
    expect(same).toBe(prev);
    const next = shareAgents(prev, [run("a"), run("b", { activity: "Reading x" }), run("c")]);
    expect(next).not.toBe(prev);
    expect(next[0]).toBe(prev[0]);
    expect(next[1]).not.toBe(prev[1]);
    expect(next[1]?.activity).toBe("Reading x");
    expect(next.map((r) => r.id)).toEqual(["a", "b", "c"]);
  });

  it("compares every field", () => {
    expect(sameAgent(run("a"), run("a"))).toBe(true);
    expect(sameAgent(run("a"), run("a", { totalTokens: 1 }))).toBe(false);
    expect(sameAgent(run("a"), run("a", { endedAtMs: 5 }))).toBe(false);
  });
});

describe("parseAgentNote", () => {
  it.each([
    ["Agent finished · PR 1 · Added tests; make check is green.", "", { failed: false, name: "PR 1", summary: "Added tests; make check is green." }],
    ["Agent failed · Shot · Stopped: exit 1", "", { failed: true, name: "Shot", summary: "Stopped: exit 1" }],
    ["Agent finished · Quiet", "", { failed: false, name: "Quiet", summary: "" }],
    ["Agent finished · A · B · the report · with dots", "", { failed: false, name: "A", summary: "B · the report · with dots" }],
    ["Agent finished · A · B · the report", "A · B", { failed: false, name: "A · B", summary: "the report" }],
    ["Agent finished · A · B", "A · B", { failed: false, name: "A · B", summary: "" }],
    ["Agent finished · Other · x", "A", { failed: false, name: "Other", summary: "x" }],
  ])("%s", (text, name, want) => {
    expect(parseAgentNote(text, name)).toEqual(want);
  });

  it.each(["Forked from Fix the badge", "Agent finished", "agent finished · x"])("not an agent note: %s", (text) => {
    expect(parseAgentNote(text)).toBeNull();
  });
});
