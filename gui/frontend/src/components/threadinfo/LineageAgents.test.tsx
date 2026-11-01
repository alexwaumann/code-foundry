import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunView } from "@/api/agents";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { thread } = await import("@/test/projectsWorld");
const { useThreadStore } = await import("@/stores/thread");
const { useThreadsStore } = await import("@/stores/threads");
const { LineageGroup } = await import("./LineageGroup");

/**
 * The thread info card's agent rows (LineageGroup) over the mock's "agents" s-r1
 * (mock/agents.ts): a click opens the run (thread.agent.open); the finished ones fold under
 * Previous agents. What the run's view shows: src/components/thread/SubagentPane.test.tsx.
 */

const NOW = Date.now();

function run(id: string, description: string, o: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id,
    toolUseId: `toolu_${id}`,
    parentId: "",
    description,
    agentType: "general-purpose",
    model: "opus",
    effort: "high",
    background: true,
    spawnDepth: 1,
    status: "running",
    activity: "",
    lastTool: "",
    totalTokens: 0,
    toolUses: 0,
    durationMs: 0,
    summary: "",
    error: "",
    startedAtMs: NOW - 240_000,
    resumedAtMs: null,
    endedAtMs: null,
    noteItemId: "",
    ...o,
  };
}

const RUNS = [
  run("a0", "Find the header chip pattern", { agentType: "Explore", model: "haiku", background: false, status: "done", endedAtMs: NOW - 318_000 }),
  run("a1", "PR 1: daemon task frames"),
  run("a2", "PR 2: Agents surface in the panel"),
  run("a3", "Screenshot the panel in Wails", { status: "failed", error: "Stopped: process exited with code 1", endedAtMs: NOW - 183_000 }),
];

const row = (id: string) => document.querySelector<HTMLElement>(`[data-testid="ti-lineage-row"][data-kind="agent"][data-id="${id}"]`);

beforeEach(() => {
  resetDaemon();
  useThreadsStore.setState({ byId: { "s-r1": thread("s-r1", { name: "Agents panel", state: "connected" }) }, order: ["s-r1"] });
  useThreadStore.setState({ logs: { "s-r1": { seq: 1, byId: {}, order: [], pending: [], mcp: null, commands: [], agents: RUNS } } });
});

afterEach(() => {
  cleanup();
  useThreadStore.setState({ logs: {} });
});

describe("the card's agent rows", () => {
  it("a running run's row opens it; the finished ones are under Previous agents, and open too", () => {
    render(<LineageGroup threadId="s-r1" />);
    expect(row("a0")).toBeNull();
    fireEvent.click(row("a2") as HTMLElement);
    expect(invocationsOf("thread.agent.open").map((i) => i.args)).toEqual([{ id: "s-r1", run: "a2" }]);
    fireEvent.click(screen.getByTestId("ti-previous"));
    fireEvent.click(row("a0") as HTMLElement);
    expect(invocationsOf("thread.agent.open").map((i) => i.args).at(-1)).toEqual({ id: "s-r1", run: "a0" });
  });
});
