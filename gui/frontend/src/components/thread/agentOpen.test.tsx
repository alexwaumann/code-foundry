import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { CommandView } from "@/api/command";
import type { ThreadItemView } from "@/api/thread";
import type { ThreadView } from "@/api/threads";

const openAgentRun = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/subagentActions", async (orig) => ({ ...(await orig<typeof import("@/stores/subagentActions")>()), openAgentRun }));

const { buildRows, buildTurns, decodeTimelineKey, timelineKey } = await import("@/lib/threadTimeline");
const { useCommandsStore } = await import("@/stores/commands");
const { structOf, useThreadStore } = await import("@/stores/thread");
const { useThreadsStore } = await import("@/stores/threads");
const { ThreadContext } = await import("./context");
const { TimelineRowView } = await import("./rows");
const { AgentsStrip } = await import("./AgentsStrip");

/** The read-only subagent view's entry points in the thread: Open on Agent rows and agent notes, run names in the strip. */

const NOW = Date.now();
const base = { parentToolUseId: "", createdAtMs: NOW - 60_000, updatedAtMs: NOW, streaming: false };

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

const call = (id: string, parent = ""): ThreadItemView => ({
  ...base,
  id,
  ordinal: 2,
  parentToolUseId: parent,
  kind: "tool",
  toolUseId: id,
  name: "Agent",
  inputJson: JSON.stringify({ description: id }),
  status: "running",
  output: "",
  isError: false,
  resultJson: "",
});
const user: ThreadItemView = { ...base, id: "u", ordinal: 1, kind: "user", text: "go", attachments: [], composerText: "" };
const note = (id: string, text: string): ThreadItemView => ({ ...base, id, ordinal: 9, kind: "note", text, createdBy: "" });

const cmd = (name: string) => ({ name, title: name, available: true, args: [], keybindings: [] }) as unknown as CommandView;

function setLog(items: ThreadItemView[], agents: AgentRunView[]): void {
  useThreadStore.setState({ logs: { s: { seq: 1, byId: Object.fromEntries(items.map((it) => [it.id, it])), order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents } }, expanded: {} });
}

function showTimeline(items: ThreadItemView[], agents: AgentRunView[]) {
  setLog(items, agents);
  const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: () => undefined, working: true });
  return render(
    <div className="cf-thread">
      <ThreadContext.Provider value={{ threadId: "s", cwd: "/w" }}>
        {rows.map((r) => (
          <TimelineRowView key={r.key} row={r} />
        ))}
      </ThreadContext.Provider>
    </div>,
  ).container;
}

beforeEach(() => {
  openAgentRun.mockClear();
  useCommandsStore.setState({ commands: [cmd("thread.agent.open"), cmd("view.panel.agents")] });
});

afterEach(cleanup);

describe("Open on Agent rows", () => {
  it("a thread's own run has Open (beside the row, which still folds); a nested one has none", () => {
    // a1 is the thread's own (expanded: a running foreground run), n1 its nested run.
    const el = showTimeline([user, call("toolu_a1"), call("toolu_n1", "toolu_a1")], [run("a1", { background: false }), run("n1", { parentId: "a1", spawnDepth: 2, background: false })]);
    const opens = screen.getAllByTestId("thread-agent-open");
    expect(opens.map((b) => b.getAttribute("data-run"))).toEqual(["a1"]);
    expect(opens[0]?.textContent).toBe("Open");
    expect(opens[0]?.getAttribute("aria-label")).toBe("Open run a1");
    // Not inside the row's own button: the row still toggles.
    const host = opens[0]?.closest(".agent-host");
    expect(host?.querySelector(":scope > button.row")).not.toBeNull();
    expect(opens[0]?.closest("button.row")).toBeNull();
    fireEvent.click(opens[0] as HTMLElement);
    expect(openAgentRun).toHaveBeenCalledWith("s", "a1");
    expect(el.querySelectorAll(".agent-host")).toHaveLength(1);
  });

  it("nothing to open without a known run, or where thread.agent.open is not listed", () => {
    showTimeline([user, call("toolu_a1")], []);
    expect(screen.queryByTestId("thread-agent-open")).toBeNull();
    cleanup();
    useCommandsStore.setState({ commands: [] });
    showTimeline([user, call("toolu_a1")], [run("a1")]);
    expect(screen.queryByTestId("thread-agent-open")).toBeNull();
  });
});

describe("Open on agent notes", () => {
  it("after the age when the note's run is known", () => {
    showTimeline([note("n9", "Agent failed · Shot · Stopped")], [run("a3", { description: "Shot", status: "failed", noteItemId: "n9" })]);
    const open = screen.getByTestId("thread-agent-note-open");
    expect(open.previousElementSibling?.className).toBe("ago");
    fireEvent.click(open);
    expect(openAgentRun).toHaveBeenCalledWith("s", "a3");
  });

  it("none when the run is unknown", () => {
    showTimeline([note("n9", "Agent finished · Shot · done")], []);
    expect(screen.getByTestId("thread-agent-note")).toBeTruthy();
    expect(screen.queryByTestId("thread-agent-note-open")).toBeNull();
  });
});

describe("the strip's run names", () => {
  const thread = { id: "s", state: "connected", status: "idle", archivedAtMs: null, agentsRunning: 2, backgroundAgentsRunning: 2, backgroundShellsRunning: 0 } as ThreadView;

  it("are links that open their run; the line reads as before", () => {
    useThreadsStore.setState({ byId: { s: thread }, order: ["s"] });
    setLog([], [run("a1", { description: "PR 1", activity: "Running go test" }), run("a2", { description: "PR 2" })]);
    render(<AgentsStrip threadId="s" />);
    expect(screen.getByTestId("agents-strip-runs").textContent).toBe("PR 1 · Running go testPR 2");
    const names = screen.getAllByTestId("agents-strip-name");
    expect(names.map((n) => n.textContent)).toEqual(["PR 1", "PR 2"]);
    fireEvent.click(names[1] as HTMLElement);
    expect(openAgentRun).toHaveBeenCalledWith("s", "a2");
  });

  it("are plain text where thread.agent.open is not listed", () => {
    useCommandsStore.setState({ commands: [cmd("view.panel.agents")] });
    useThreadsStore.setState({ byId: { s: thread }, order: ["s"] });
    setLog([], [run("a1", { description: "PR 1" }), run("a2", { description: "PR 2" })]);
    render(<AgentsStrip threadId="s" />);
    expect(screen.queryByTestId("agents-strip-name")).toBeNull();
    expect(screen.getByTestId("agents-strip-runs").textContent).toBe("PR 1PR 2");
  });
});
