import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { CommandView } from "@/api/command";
import type { ThreadView } from "@/api/threads";

const openAgentRun = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/subagentActions", async (orig) => ({ ...(await orig<typeof import("@/stores/subagentActions")>()), openAgentRun }));

const { AgentsSurface } = await import("@/components/agents/AgentsSurface");
const { useCommandsStore } = await import("@/stores/commands");
const { leaveSubagent, showAgentRun, useSubagentViewStore } = await import("@/stores/subagentView");
const { useThreadStore } = await import("@/stores/thread");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");

/** The Agents tab as an entry point of the read-only subagent view: the thread's own runs open, the viewed one is marked. */

const NOW = Date.now();

function run(id: string, o: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id,
    toolUseId: `toolu_${id}`,
    parentId: "",
    description: `run ${id}`,
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
    startedAtMs: NOW - 60_000,
    resumedAtMs: null,
    endedAtMs: null,
    noteItemId: "",
    ...o,
  };
}

const RUNS = [run("a0", { status: "done", endedAtMs: NOW - 60_000 }), run("a1"), run("a1b", { parentId: "a1", spawnDepth: 2 }), run("a3", { status: "failed", endedAtMs: NOW })];
const cmd = (name: string) => ({ name, title: name, available: true, args: [], keybindings: [] }) as unknown as CommandView;
const rowOf = (id: string) => document.querySelector(`[data-testid="agent-row"][data-agent="${id}"]`) as HTMLElement;

beforeEach(() => {
  openAgentRun.mockClear();
  useCommandsStore.setState({ commands: [cmd("thread.agent.open")] });
  useThreadsStore.setState({ byId: { s: { id: "s", name: "Agents panel" } as ThreadView }, order: ["s"] });
  useThreadStore.setState({ logs: { s: { seq: 1, byId: {}, order: [], pending: [], mcp: null, commands: [], agents: RUNS } } });
  useUiStore.setState({ selection: { kind: "thread", id: "s" } });
  useSubagentViewStore.setState({ viewing: null, focusSeq: 0 });
});

afterEach(cleanup);

describe("Agents tab rows", () => {
  it("the thread's own runs are buttons with a chevron that open the run; nested ones are not", () => {
    render(<AgentsSurface />);
    expect([...screen.getByTestId("agents-surface").querySelectorAll("button")].map((b) => b.getAttribute("data-agent"))).toEqual(["a0", "a1", "a3"]);
    expect(rowOf("a1b").tagName).toBe("LI");
    expect(rowOf("a1b").querySelector('[data-testid="agent-open-chevron"]')).toBeNull();
    // The chevron comes after the status word.
    const chev = rowOf("a1").querySelector('[data-testid="agent-open-chevron"]');
    expect(chev?.previousElementSibling?.getAttribute("data-testid")).toBe("agent-status");
    fireEvent.click(rowOf("a3"));
    expect(openAgentRun).toHaveBeenCalledWith("s", "a3");
  });

  it("the viewed row: sky bar and tint, a viewing tag before the status, for as long as it shows", () => {
    render(<AgentsSurface />);
    expect(screen.queryByTestId("agent-viewing")).toBeNull();
    act(() => {
      showAgentRun("s", "a1");
    });
    const row = rowOf("a1");
    expect(row.getAttribute("data-viewing")).toBe("true");
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(row.className).toContain("bg-cf-info/7");
    expect(row.querySelector(".bg-cf-info.w-0\\.5")).not.toBeNull();
    const tag = screen.getByTestId("agent-viewing");
    expect(tag.textContent).toBe("viewing");
    expect(tag.nextElementSibling?.getAttribute("data-testid")).toBe("agent-status");
    expect(rowOf("a0").getAttribute("data-viewing")).toBeNull();
    act(() => {
      leaveSubagent();
    });
    expect(screen.queryByTestId("agent-viewing")).toBeNull();
  });

  it("no buttons where thread.agent.open is not listed (an older daemon)", () => {
    useCommandsStore.setState({ commands: [] });
    render(<AgentsSurface />);
    expect(screen.getByTestId("agents-surface").querySelectorAll("button")).toHaveLength(0);
  });
});
