import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { SessionView } from "@/api/session";
import { useCommandsStore } from "@/stores/commands";
import { useSessionsStore } from "@/stores/sessions";
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

const session = (o: Partial<SessionView>) => ({ id: "s", state: "connected", status: "idle", archivedAtMs: null, agentsRunning: 0, backgroundAgentsRunning: 0, ...o }) as SessionView;

function setup(o: Partial<SessionView>, agents: AgentRunView[]) {
  useSessionsStore.setState({ byId: { s: session(o) }, order: ["s"] });
  useThreadStore.setState({ logs: { s: { seq: 1, byId: {}, order: [], pending: [], mcp: null, commands: [], agents } } });
  render(<AgentsStrip sessionId="s" />);
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

  it.each([
    ["only foreground runs (mid-turn)", { agentsRunning: 2, backgroundAgentsRunning: 0 }],
    ["none", {}],
    ["archived", { agentsRunning: 2, backgroundAgentsRunning: 2, archivedAtMs: 5 }],
  ])("hidden: %s", (_n, o) => {
    setup(o, RUNS);
    expect(screen.queryByTestId("agents-strip")).toBeNull();
  });

  it("follows the session's count", () => {
    setup({ agentsRunning: 1, backgroundAgentsRunning: 1 }, [run("PR 1")]);
    expect(screen.getByTestId("agents-strip")).not.toBeNull();
    act(() => {
      useSessionsStore.setState({ byId: { s: session({ backgroundAgentsRunning: 0 }) } });
    });
    expect(screen.queryByTestId("agents-strip")).toBeNull();
  });
});
