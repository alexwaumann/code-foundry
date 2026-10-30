import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { CommandView } from "@/api/command";
import type { ThreadItemView } from "@/api/thread";
import type { ThreadView } from "@/api/threads";

vi.mock("sonner", () => ({ toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn(), success: vi.fn() } }));

const { getViewing, leaveSubagent, showAgentRun, useRunTimelineKeys, useShownRun, useSubagentViewStore, useViewingRun } = await import("./subagentView");
const { applyIntent } = await import("./intents");
const { getUiContext } = await import("./context");
const { inPalette, presentCommand } = await import("@/keys/bindings");
const { useThreadStore } = await import("./thread");
const { useThreadsStore } = await import("./threads");
const { useUiStore } = await import("./ui");

/** The subagent view's window state (stores/subagentView.ts) and how commands and intents reach it. */

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

const base = { createdAtMs: NOW, updatedAtMs: NOW, streaming: false };
const tool = (id: string, parent: string, o: Partial<Extract<ThreadItemView, { kind: "tool" }>> = {}): ThreadItemView => ({
  ...base,
  id,
  ordinal: 1,
  parentToolUseId: parent,
  kind: "tool",
  toolUseId: id,
  name: "Bash",
  inputJson: "{}",
  status: "done",
  output: "",
  isError: false,
  resultJson: "",
  ...o,
});
const text = (id: string, parent: string, t: string): ThreadItemView => ({ ...base, id, ordinal: 1, parentToolUseId: parent, kind: "text", text: t });

const thread = (id: string) => ({ id, name: `thread ${id}`, projectId: "", worktreePath: "/w", workspaceId: "", state: "connected", status: "idle" }) as unknown as ThreadView;

function setLog(threadId: string, items: ThreadItemView[], agents: AgentRunView[]): void {
  useThreadStore.setState((s) => ({
    logs: { ...s.logs, [threadId]: { seq: 1, byId: Object.fromEntries(items.map((it) => [it.id, it])), order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents } },
  }));
}

const RUNS = [run("a1"), run("a2", { status: "done" }), run("n1", { parentId: "a1", spawnDepth: 2 })];
const ITEMS = [tool("toolu_a1", ""), tool("b1", "toolu_a1"), tool("toolu_n1", "toolu_a1", { name: "Agent" }), tool("nb", "toolu_n1"), text("t1", "toolu_a1", "Tests pass"), tool("toolu_a2", "")];

beforeEach(() => {
  useThreadsStore.setState({ byId: { s1: thread("s1"), s2: thread("s2") }, order: ["s1", "s2"] });
  useThreadStore.setState({ logs: {} });
  setLog("s1", ITEMS, RUNS);
  useSubagentViewStore.setState({ viewing: null, focusSeq: 0 });
  useUiStore.setState({ selection: { kind: "thread", id: "s1" }, promptFocusSeq: 0, palette: { ...useUiStore.getState().palette, open: false } });
});

afterEach(cleanup);

describe("showAgentRun", () => {
  it("shows one of the selected thread's own runs, asking the view to take the keyboard", () => {
    expect(showAgentRun("s1", "a1")).toBe(true);
    expect(getViewing()).toEqual({ threadId: "s1", runId: "a1" });
    expect(useSubagentViewStore.getState().focusSeq).toBe(1);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s1" });
  });

  it("selects another thread first, keeping its run on trust until its log comes", () => {
    expect(showAgentRun("s2", "x9")).toBe(true);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s2" });
    expect(getViewing()).toEqual({ threadId: "s2", runId: "x9" });
    // The log arrives without the run: the view goes.
    act(() => {
      setLog("s2", [], [run("a5")]);
    });
    expect(getViewing()).toBeNull();
  });

  it.each([
    ["a nested run", "n1"],
    ["a run the log does not have", "zz"],
  ])("refuses %s", (_name, id) => {
    expect(showAgentRun("s1", id)).toBe(false);
    expect(getViewing()).toBeNull();
  });
});

describe("the view goes", () => {
  it("when another thread or a page is selected", () => {
    showAgentRun("s1", "a1");
    useUiStore.getState().select({ kind: "thread", id: "s1" });
    expect(getViewing()).not.toBeNull();
    useUiStore.getState().select({ kind: "thread", id: "s2" });
    expect(getViewing()).toBeNull();
    useUiStore.getState().select({ kind: "thread", id: "s1" });
    showAgentRun("s1", "a1");
    useUiStore.getState().select({ kind: "view", name: "projects" });
    expect(getViewing()).toBeNull();
  });

  it("when the run leaves the thread's list, not on its progress", () => {
    showAgentRun("s1", "a1");
    setLog("s1", ITEMS, [run("a1", { activity: "Reading x" }), RUNS[1] as AgentRunView]);
    expect(getViewing()).not.toBeNull();
    setLog("s1", ITEMS, [RUNS[1] as AgentRunView]);
    expect(getViewing()).toBeNull();
  });

  it("on leaveSubagent, the thread's prompt taking the keyboard", () => {
    expect(leaveSubagent()).toBe(false);
    showAgentRun("s1", "a1");
    expect(leaveSubagent()).toBe(true);
    expect(getViewing()).toBeNull();
    expect(useUiStore.getState().promptFocusSeq).toBe(1);
  });
});

describe("selectors", () => {
  it("useViewingRun and useShownRun follow the viewing state and the log", () => {
    const { result } = renderHook(() => [useViewingRun("s1"), useViewingRun("s2"), useShownRun("s1")]);
    expect(result.current).toEqual(["", "", ""]);
    act(() => {
      showAgentRun("s1", "a1");
    });
    expect(result.current).toEqual(["a1", "", "a1"]);
    // A view state the log no longer backs shows the thread (before the subscription drops it).
    act(() => {
      useSubagentViewStore.setState({ viewing: { threadId: "s1", runId: "n1" } });
    });
    expect(result.current[2]).toBe("");
  });

  it("useRunTimelineKeys: the run's own items, stable across text deltas and progress", () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders++;
      return useRunTimelineKeys("s1", "toolu_a1");
    });
    expect(result.current.map((k) => k.split("\u0001")[0])).toEqual(["b1", "toolu_n1", "t1"]);
    const before = renders;
    act(() => {
      // A text delta and a progress update: the keys stay.
      setLog("s1", [...ITEMS.slice(0, 4), text("t1", "toolu_a1", "Tests pass, now the migration"), ITEMS[5] as ThreadItemView], [run("a1", { activity: "Editing" }), ...RUNS.slice(1)]);
    });
    expect(renders).toBe(before);
    act(() => {
      setLog("s1", [...ITEMS, tool("b2", "toolu_a1", { status: "running" })], RUNS);
    });
    expect(result.current.map((k) => k.split("\u0001")[0])).toEqual(["b1", "toolu_n1", "t1", "b2"]);
  });
});

describe("commands and intents", () => {
  it("the command context's active view is thread.agent while a run shows", () => {
    expect(getUiContext().activeView).toBe("thread");
    showAgentRun("s1", "a1");
    expect(getUiContext().activeView).toBe("thread.agent");
    expect(getUiContext({ kind: "thread", id: "s2" }).activeView).toBe("thread");
  });

  it("UiIntent.ShowAgentRun shows the run, ShowView agent.up leaves it", () => {
    useUiStore.setState({ selection: { kind: "view", name: "dashboard" } });
    applyIntent({ kind: "showAgentRun", threadId: "s1", runId: "a2" });
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s1" });
    expect(getViewing()).toEqual({ threadId: "s1", runId: "a2" });
    applyIntent({ kind: "showView", name: "agent.up" });
    expect(getViewing()).toBeNull();
  });

  it("thread.agent.up is presented in this window", () => {
    showAgentRun("s1", "a1");
    expect(presentCommand("thread.agent.up")).toBe(true);
    expect(getViewing()).toBeNull();
  });

  it("the palette does not list thread.agent.open (the daemon marks it NoPalette)", () => {
    const cmd = (name: string) => ({ name, title: name, available: true, args: [], keybindings: [] }) as unknown as CommandView;
    expect(inPalette({ ...cmd("thread.agent.open"), noPalette: true })).toBe(false);
    expect(inPalette(cmd("thread.agent.up"))).toBe(true);
    expect(inPalette({ ...cmd("thread.agent.up"), available: false })).toBe(false);
  });
});
