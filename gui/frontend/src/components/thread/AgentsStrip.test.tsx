import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { ThreadView } from "@/api/threads";
import { useCommandsStore } from "@/stores/commands";
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

beforeEach(() => {
  useCommandsStore.setState({ commands: [{ name: "view.panel.agents", title: "Show Agents", available: true } as never] });
});

afterEach(cleanup);

describe("AgentsStrip", () => {
  it("names the thread's running background runs and links the Agents tab", () => {
    setup({ agentsRunning: 4, backgroundAgentsRunning: 2 }, RUNS);
    expect(screen.getByTestId("agents-strip-count").textContent).toBe("2 agents running in the background");
    expect(screen.getByTestId("agents-strip-runs").textContent).toBe("PR 1 · Running go testPR 2");
    expect(screen.getByTestId("agents-strip-open").textContent).toBe("Agents");
    expect(screen.getByTestId("agents-strip-open").getAttribute("data-command-button")).toBe("view.panel.agents");
  });

  it("singular for one", () => {
    setup({ agentsRunning: 1, backgroundAgentsRunning: 1 }, [run("PR 1")]);
    expect(screen.getByTestId("agents-strip-count").textContent).toBe("1 agent running in the background");
  });

  it("counts shells beside the agents: one sentence, the agents' layout", () => {
    setup({ agentsRunning: 4, backgroundAgentsRunning: 2, backgroundShellsRunning: 1 }, RUNS);
    const strip = screen.getByTestId("agents-strip");
    expect(screen.getByTestId("agents-strip-count").textContent).toBe("2 agents and 1 shell running in the background");
    expect(screen.getByTestId("agents-strip-runs").textContent).toBe("PR 1 · Running go testPR 2");
    expect(screen.getByTestId("agents-strip-open")).not.toBeNull();
    expect(strip.querySelector(".lucide-bot")).not.toBeNull();
    expect(strip.querySelector(".lucide-square-terminal")).toBeNull();
  });

  it("shells only: the sentence behind a terminal icon, no activity, no Agents button", () => {
    setup({ backgroundShellsRunning: 2 }, RUNS);
    const strip = screen.getByTestId("agents-strip");
    expect(screen.getByTestId("agents-strip-count").textContent).toBe("2 shells running in the background");
    expect(strip.textContent).toBe("2 shells running in the background");
    expect(strip.querySelector(".lucide-square-terminal")).not.toBeNull();
    expect(strip.querySelector(".lucide-bot")).toBeNull();
    expect(screen.queryByTestId("agents-strip-runs")).toBeNull();
    expect(screen.queryByTestId("agents-strip-open")).toBeNull();
  });

  it("one shell", () => {
    setup({ backgroundShellsRunning: 1 }, []);
    expect(screen.getByTestId("agents-strip-count").textContent).toBe("1 shell running in the background");
  });

  it.each([
    ["only foreground runs (mid-turn)", { agentsRunning: 2, backgroundAgentsRunning: 0 }],
    ["none", {}],
    ["archived", { agentsRunning: 2, backgroundAgentsRunning: 2, archivedAtMs: 5 }],
    ["archived with shells", { backgroundShellsRunning: 1, archivedAtMs: 5 }],
  ])("hidden: %s", (_n, o) => {
    setup(o, RUNS);
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

  it("follows the counts: agents end, the shell remains, then it ends", () => {
    setup({ agentsRunning: 1, backgroundAgentsRunning: 1, backgroundShellsRunning: 1 }, [run("PR 1")]);
    expect(screen.getByTestId("agents-strip").getAttribute("data-kind")).toBe("agents");
    act(() => {
      useThreadsStore.setState({ byId: { s: thread({ backgroundShellsRunning: 1 }) } });
    });
    expect(screen.getByTestId("agents-strip").getAttribute("data-kind")).toBe("shells");
    expect(screen.getByTestId("agents-strip-count").textContent).toBe("1 shell running in the background");
    act(() => {
      useThreadsStore.setState({ byId: { s: thread({}) } });
    });
    expect(screen.queryByTestId("agents-strip")).toBeNull();
  });
});
