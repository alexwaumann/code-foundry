import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { ThreadView } from "@/api/threads";
import { useThreadsStore } from "@/stores/threads";
import { useThreadStore } from "@/stores/thread";
import { AgentsStrip } from "./AgentsStrip";

function run(id: string, o: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id,
    toolUseId: "",
    parentId: "",
    description: id,
    agentType: "general-purpose",
    model: "",
    effort: "",
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
    startedAtMs: 1,
    resumedAtMs: null,
    endedAtMs: null,
    noteItemId: "",
    ...o,
  };
}

const thread = (o: Partial<ThreadView>) => ({ id: "s", state: "connected", status: "idle", archivedAtMs: null, agentsRunning: 0, backgroundAgentsRunning: 0, backgroundShellsRunning: 0, ...o }) as ThreadView;

function setup(o: Partial<ThreadView>, agents: AgentRunView[]) {
  useThreadsStore.setState({ byId: { s: thread(o) }, order: ["s"] });
  useThreadStore.setState({ logs: { s: { seq: 1, byId: {}, order: [], pending: [], mcp: null, commands: [], agents } } });
  render(<AgentsStrip threadId="s" />);
}

const RUNS = [
  run("PR 1", { activity: "Running go test" }),
  run("Nested", { parentId: "PR 1", spawnDepth: 2, activity: "Reading x" }),
  run("PR 2", { activity: "PR 2" }),
  run("Explore", { background: false, activity: "Reading y" }),
  run("Gone", { status: "failed" }),
];

afterEach(cleanup);

describe("AgentsStrip", () => {
  it("names the thread's running background runs", () => {
    setup({ agentsRunning: 4, backgroundAgentsRunning: 2 }, RUNS);
    expect(screen.getByTestId("agents-strip-count").textContent).toBe("2 agents running in the background");
    expect(screen.getByTestId("agents-strip").dataset.kind).toBe("agents");
    expect(screen.getByTestId("agents-strip-runs").textContent).toBe("PR 1 · Running go testPR 2");
    expect(screen.queryByTestId("agents-strip-open")).toBeNull();
  });

  it("singular for one", () => {
    setup({ agentsRunning: 1, backgroundAgentsRunning: 1 }, [run("PR 1")]);
    expect(screen.getByTestId("agents-strip-count").textContent).toBe("1 agent running in the background");
  });

  it("leaves background shells to the thread info card", () => {
    setup({ agentsRunning: 4, backgroundAgentsRunning: 2, backgroundShellsRunning: 1 }, RUNS);
    expect(screen.getByTestId("agents-strip-count").textContent).toBe("2 agents running in the background");
  });

  it.each([
    ["only foreground runs (mid-turn)", { agentsRunning: 2, backgroundAgentsRunning: 0 }],
    ["none", {}],
    ["shells only", { backgroundShellsRunning: 2 }],
    ["archived", { agentsRunning: 2, backgroundAgentsRunning: 2, archivedAtMs: 5 }],
  ])("hidden: %s", (_n, o) => {
    setup(o, RUNS);
    expect(screen.queryByTestId("agents-strip")).toBeNull();
  });

  it("follows the thread's count and its runs: one ends, then the last, while a shell and a foreground run go on", () => {
    setup({ agentsRunning: 4, backgroundAgentsRunning: 2, backgroundShellsRunning: 1 }, RUNS);
    act(() => {
      useThreadsStore.setState({ byId: { s: thread({ agentsRunning: 3, backgroundAgentsRunning: 1, backgroundShellsRunning: 1 }) } });
      useThreadStore.setState({ logs: { s: { seq: 2, byId: {}, order: [], pending: [], mcp: null, commands: [], agents: RUNS.map((r) => (r.id === "PR 1" ? { ...r, status: "done" as const } : r)) } } });
    });
    expect(screen.getByTestId("agents-strip-count").textContent).toBe("1 agent running in the background");
    expect(screen.getByTestId("agents-strip-runs").textContent).toBe("PR 2");
    act(() => {
      useThreadsStore.setState({ byId: { s: thread({ agentsRunning: 2, backgroundAgentsRunning: 0, backgroundShellsRunning: 1 }) } });
    });
    expect(screen.queryByTestId("agents-strip")).toBeNull();
  });

  it("follows the thread's count", () => {
    setup({ agentsRunning: 1, backgroundAgentsRunning: 1 }, [run("PR 1")]);
    expect(screen.getByTestId("agents-strip")).not.toBeNull();
    act(() => {
      useThreadsStore.setState({ byId: { s: thread({ backgroundAgentsRunning: 0 }) } });
    });
    expect(screen.queryByTestId("agents-strip")).toBeNull();
  });
});
