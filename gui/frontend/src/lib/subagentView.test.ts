import { describe, expect, it } from "vitest";
import type { AgentRunView } from "@/api/agents";
import { agentPrompt, footerParts, lastTextId, reportIsLastText, runItems, runNodes, turnOfCall } from "./subagentView";
import type { TimelineItem } from "./threadTimeline";

/** The read-only subagent view's pure helpers. */

function item(id: string, o: Partial<TimelineItem> = {}): TimelineItem {
  return { id, kind: "text", name: "", parentToolUseId: "", toolUseId: "", toolStatus: "", requestState: "", streaming: false, ...o };
}
const tool = (id: string, name: string, o: Partial<TimelineItem> = {}) => item(id, { kind: "tool", name, toolUseId: id, toolStatus: "done", ...o });

// The parent's turn 1 launches A1 (which runs Read, Grep, a nested Agent N with its own
// Read, an Edit and a text) and turn 2 launches A2.
const ITEMS: TimelineItem[] = [
  item("u1", { kind: "user" }),
  tool("A1", "Agent"),
  tool("r1", "Read", { parentToolUseId: "A1" }),
  tool("g1", "Grep", { parentToolUseId: "A1" }),
  tool("N", "Agent", { parentToolUseId: "A1", toolStatus: "running" }),
  tool("nr", "Read", { parentToolUseId: "N" }),
  item("x1", { kind: "text" }),
  tool("e1", "Edit", { parentToolUseId: "A1" }),
  item("t1", { parentToolUseId: "A1", streaming: true }),
  item("end1", { kind: "turnEnd" }),
  item("note", { kind: "note" }),
  item("u2", { kind: "user" }),
  tool("A2", "Agent"),
  item("end2", { kind: "turnEnd" }),
];

describe("runItems", () => {
  it.each([
    ["the run's own items, in order", "A1", ["r1", "g1", "N", "e1", "t1"]],
    ["a nested run's (none from the stream, here one)", "N", ["nr"]],
    ["a run without work", "A2", []],
    ["no call id", "", []],
  ])("%s", (_name, call, want) => {
    expect(runItems(ITEMS, call).map((it) => it.id)).toEqual(want);
  });
});

describe("runNodes", () => {
  it("groups reads, keeps a nested Agent call without children, ends with the text", () => {
    const nodes = runNodes(runItems(ITEMS, "A1"));
    expect(nodes.map((n) => n.type)).toEqual(["group", "tool", "tool", "text"]);
    const nested = nodes[1];
    expect(nested?.type === "tool" && nested.name === "Agent" && nested.children).toEqual([]);
    expect(lastTextId(nodes)).toBe("t1");
  });

  it("puts a permission on its tool row", () => {
    const items = [tool("b", "Bash", { parentToolUseId: "A" }), item("p", { kind: "permission", toolUseId: "b", parentToolUseId: "A", requestState: "pending" })];
    const nodes = runNodes(items);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]?.type === "tool" && nodes[0].permissionId).toBe("p");
  });

  it("leaves out the handback call: its report is the run's summary, shown as the report block", () => {
    const items = [tool("b", "Bash", { parentToolUseId: "A" }), tool("h", "SubagentHandback", { parentToolUseId: "A" })];
    expect(runNodes(items).map((n) => n.type === "tool" && n.name)).toEqual(["Bash"]);
    expect(lastTextId(runNodes(items))).toBe("");
  });

  it("has no last text without text", () => {
    expect(lastTextId(runNodes([tool("b", "Bash")]))).toBe("");
  });
});

describe("turnOfCall", () => {
  it.each([
    ["turn 1's call", "A1", 1],
    // The daemon's note between the turns is no turn of the conversation.
    ["turn 2's call", "A2", 2],
    ["a nested call is no turn's own", "N", 0],
    ["unknown", "zz", 0],
    ["none", "", 0],
  ])("%s", (_name, call, want) => {
    expect(turnOfCall(ITEMS, call)).toBe(want);
  });
});

describe("agentPrompt", () => {
  it.each([
    ['{"description":"x","prompt":"Build PR 1."}', "Build PR 1."],
    ['{"description":"x"}', ""],
    ['{"prompt":3}', ""],
    ["not json", ""],
    ["null", ""],
  ])("%s", (input, want) => {
    expect(agentPrompt(input)).toBe(want);
  });
});

describe("reportIsLastText", () => {
  it.each([
    ["the same text", "Done.", "Done.\n", true],
    ["another text", "Done.", "Working on it", false],
    ["no report", "", "", false],
    ["no text", "Done.", "", false],
  ])("%s", (_name, summary, last, want) => {
    expect(reportIsLastText(summary, last)).toBe(want);
  });
});

describe("footerParts", () => {
  const NOW = 1_000_000;
  const run = (o: Partial<AgentRunView>) =>
    ({ status: "running", startedAtMs: NOW - 252_000, resumedAtMs: null, endedAtMs: null, durationMs: 0, toolUses: 23, totalTokens: 48_200, error: "", ...o }) as AgentRunView;
  it.each([
    ["running", run({}), "Opus 4.8", ["Working for 4m 12s", "23 tools", "48.2K tokens", "Opus 4.8"]],
    ["done", run({ status: "done", durationMs: 38_000, toolUses: 1, totalTokens: 6_100 }), "haiku", ["Worked for 38s", "1 tool", "6.1K tokens", "haiku"]],
    ["done, no counters or model", run({ status: "done", durationMs: 0, startedAtMs: null, toolUses: 0, totalTokens: 0 }), "", ["Worked"]],
    ["failed", run({ status: "failed", error: "Stopped: process exited with code 1" }), "opus", ["Stopped: process exited with code 1"]],
    ["failed without an error", run({ status: "failed" }), "opus", ["Failed"]],
  ])("%s", (_name, r, model, want) => {
    expect(footerParts(r, model, NOW)).toEqual(want);
  });
});
