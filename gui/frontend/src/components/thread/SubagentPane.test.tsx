import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { CommandView } from "@/api/command";
import type { ThreadItemView } from "@/api/thread";
import type { ThreadView } from "@/api/threads";

// The list itself is the timeline's virtualized one (Timeline.tsx); here every row renders.
vi.mock("./Timeline", () => ({
  Timeline: () => <div data-testid="thread-timeline" />,
  TimelineList: ({ rows, renderRow }: { rows: { key: string; type: string }[]; renderRow: (r: never) => ReactNode }) => (
    <div data-testid="subagent-list">
      {rows.map((r) => (
        <div key={r.key} data-row-type={r.type}>
          {renderRow(r as never)}
        </div>
      ))}
    </div>
  ),
}));
vi.mock("./ThreadComposer", () => ({ ThreadComposer: () => <div data-testid="thread-composer" /> }));
const runCommand = vi.hoisted(() => vi.fn(() => Promise.resolve(true)));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommand }));
vi.mock("@/stores/thread", async (orig) => ({ ...(await orig<typeof import("@/stores/thread")>()), startThreadWatch: () => () => undefined }));

const { SubagentPane } = await import("./SubagentPane");
const { ThreadPane } = await import("./ThreadPane");
const { installKeybindings } = await import("@/keys/bindings");
const { useCommandsStore } = await import("@/stores/commands");
const { getViewing, showAgentRun, useSubagentViewStore } = await import("@/stores/subagentView");
const { useThreadStore } = await import("@/stores/thread");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");

/** The read-only subagent view (SubagentPane.tsx): header, lineage, prompt, work, footer, report, plate, Escape. */

const NOW = Date.now();

function run(id: string, o: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id,
    toolUseId: `toolu_${id}`,
    parentId: "",
    description: "PR 1: daemon task frames",
    agentType: "general-purpose",
    model: "opus",
    effort: "high",
    background: true,
    spawnDepth: 1,
    status: "running",
    activity: "Running go test",
    lastTool: "Bash",
    totalTokens: 48_200,
    toolUses: 23,
    durationMs: 0,
    summary: "",
    error: "",
    startedAtMs: NOW - 252_000,
    resumedAtMs: null,
    endedAtMs: null,
    noteItemId: "",
    ...o,
  };
}

const base = { createdAtMs: NOW - 252_000, updatedAtMs: NOW, streaming: false };
const tool = (id: string, parent: string, o: Partial<Extract<ThreadItemView, { kind: "tool" }>> = {}): ThreadItemView => ({
  ...base,
  id,
  ordinal: 1,
  parentToolUseId: parent,
  kind: "tool",
  toolUseId: id,
  name: "Bash",
  inputJson: JSON.stringify({ command: "go test ./..." }),
  status: "done",
  output: "",
  isError: false,
  resultJson: "",
  ...o,
});
const text = (id: string, parent: string, t: string, o: Partial<ThreadItemView> = {}): ThreadItemView => ({ ...base, id, ordinal: 1, parentToolUseId: parent, kind: "text", text: t, ...o }) as ThreadItemView;
const user: ThreadItemView = { ...base, id: "u1", ordinal: 1, parentToolUseId: "", kind: "user", text: "Build it", attachments: [], composerText: "" };

const PROMPT = "Implement PR 1: the daemon side of the agents panel.";
const call = (id: string) => tool(`toolu_${id}`, "", { name: "Agent", inputJson: JSON.stringify({ description: "PR 1", prompt: PROMPT }), status: "running" });

function setLog(agents: AgentRunView[], items: ThreadItemView[]): void {
  useThreadStore.setState({ logs: { s1: { seq: 1, byId: Object.fromEntries(items.map((it) => [it.id, it])), order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents } } });
}

const ITEMS = [user, call("a1"), tool("b1", "toolu_a1", { status: "running" }), tool("toolu_n1", "toolu_a1", { name: "Agent", inputJson: JSON.stringify({ description: "Review" }) }), text("t1", "toolu_a1", "Tests pass")];
const NESTED = run("n1", { parentId: "a1", spawnDepth: 2, description: "Review", background: false });

const cmd = (name: string, o: Partial<CommandView> = {}) => ({ name, title: name, available: true, args: [], keybindings: [], ...o }) as unknown as CommandView;

beforeEach(() => {
  runCommand.mockClear();
  useThreadsStore.setState({ byId: { s1: { id: "s1", name: "Agents panel", projectId: "", worktreePath: "/w", workspaceId: "", projectIds: [], branch: "", model: "claude-opus-4-8", state: "connected", status: "idle", linkedPullRequests: [] } as unknown as ThreadView }, order: ["s1"] });
  useUiStore.setState({ selection: { kind: "thread", id: "s1" }, windowWidth: 1400, promptFocusSeq: 0, palette: { ...useUiStore.getState().palette, open: false } });
  useCommandsStore.setState({ commands: [cmd("thread.agent.up", { keybindings: ["escape"] }), cmd("thread.agent.open"), cmd("view.panel.toggle"), cmd("view.bottom.toggle"), cmd("thread.archive"), cmd("thread.rename")] });
  useSubagentViewStore.setState({ viewing: null, focusSeq: 0 });
  setLog([run("a1"), NESTED], ITEMS);
});

afterEach(cleanup);

const tid = (id: string) => screen.getByTestId(id);

function show(runId = "a1") {
  act(() => {
    showAgentRun("s1", runId);
  });
  return render(<SubagentPane threadId="s1" runId={runId} />);
}

describe("SubagentPane", () => {
  it("a running run: crumb, Read-only, live status, lineage, prompt, its own rows, footer, plate", () => {
    show();
    expect(tid("subagent-crumb-parent").textContent).toBe("Agents panel");
    expect(tid("subagent-name").textContent).toBe("PR 1: daemon task frames");
    expect(tid("subagent-readonly").textContent).toBe("Read-only");
    expect(tid("subagent-status").getAttribute("data-status")).toBe("running");
    expect(tid("subagent-status").textContent).toMatch(/^Running · 4m 1\ds$/);
    // No thread actions: only the panel toggle.
    expect(screen.queryByTestId("thread-title")).toBeNull();
    expect([...tid("pane-actions").querySelectorAll("button")].map((b) => b.getAttribute("data-testid"))).toEqual(["panel-toggle"]);
    expect(tid("subagent-lineage-parent").textContent).toBe("Agents panel");
    expect(tid("subagent-lineage-meta").textContent).toBe("background · general-purpose · Opus · high · launched by turn 1's Agent call, 4 min ago");
    expect(tid("subagent-lineage-back").textContent).toBe("Back to Agents panel");
    expect(tid("thread-user-label").textContent).toBe("Prompt from Agents panel");
    expect(tid("subagent-prompt").textContent).toContain(PROMPT);
    // The run's own items only (not the parent's message, not the nested run's), in order.
    expect([...tid("subagent-list").querySelectorAll("[data-row-type]")].map((r) => r.getAttribute("data-row-type"))).toEqual(["lineage", "prompt", "tool", "tool", "text", "footer"]);
    // The nested Agent call shows with its run's chips, not openable, one line with nothing under it.
    const nested = screen.getAllByTestId("thread-tool")[1]?.closest("[data-tool]");
    expect(nested?.getAttribute("data-tool")).toBe("Agent");
    expect(nested?.querySelector('[data-testid="thread-agent-open"]')).toBeNull();
    expect(nested?.querySelector('[data-testid="thread-tool"]')?.tagName).toBe("DIV");
    expect(nested?.querySelectorAll("[data-tool]")).toHaveLength(0);
    expect(tid("subagent-footer").textContent).toMatch(/^Working for 4m 1\ds·23 tools·48\.2K tokens·Opus$/);
    expect(tid("subagent-plate-text").textContent).toBe("Read-only. A subagent takes its instructions from its parent thread. To steer it, send a follow-up to Agents panel.");
    expect(tid("subagent-plate-chord").textContent).toBe("esc");
    expect(screen.queryByTestId("subagent-report")).toBeNull();
  });

  it("a done run: its status, footer and report, not twice when it is the last text", () => {
    setLog([run("a1", { status: "done", durationMs: 38_000, toolUses: 4, totalTokens: 6_100, endedAtMs: NOW - 5 * 60_000, summary: "Added the task frames." }), NESTED], ITEMS);
    const { unmount } = show();
    expect(tid("subagent-status").textContent).toBe("Done · 5 min ago");
    expect(tid("subagent-footer").textContent).toBe("Worked for 38s·4 tools·6.1K tokens·Opus");
    expect(tid("subagent-report").textContent).toBe("Report handed back to Agents panelAdded the task frames.");
    expect(tid("subagent-plate-text").textContent).toBe("Read-only. This agent finished and handed its report to Agents panel.");
    unmount();
    setLog([run("a1", { status: "done", summary: "Tests pass" }), NESTED], ITEMS);
    show();
    expect(screen.queryByTestId("subagent-report")).toBeNull();
  });

  it("a failed run: its status, the error in the footer, the plate", () => {
    setLog([run("a1", { status: "failed", error: "Stopped: process exited with code 1", endedAtMs: NOW - 3 * 60_000 }), NESTED], ITEMS);
    show();
    expect(tid("subagent-status").textContent).toBe("Failed · 3 min ago");
    expect(tid("subagent-footer").textContent).toBe("Stopped: process exited with code 1");
    expect(tid("subagent-footer").getAttribute("data-status")).toBe("failed");
    expect(tid("subagent-plate-text").textContent).toBe("Read-only. This agent failed. Its parent Agents panel was told.");
  });

  it("the run ending while viewed turns the view done in place: its running tool stops, the handback call is no row, the report shows", () => {
    show();
    expect(tid("subagent-status").getAttribute("data-status")).toBe("running");
    const handback = tool("h1", "toolu_a1", { name: "SubagentHandback", inputJson: JSON.stringify({ message: "Added task frame handling." }) });
    act(() => {
      setLog(
        [run("a1", { status: "done", durationMs: 252_000, endedAtMs: Date.now(), summary: "Added task frame handling to the thread store with 14 table tests; make check is green." }), NESTED],
        [...ITEMS.map((it) => (it.id === "b1" ? { ...it, status: "done" } as ThreadItemView : it)), handback],
      );
    });
    expect(tid("subagent-status").getAttribute("data-status")).toBe("done");
    expect(tid("subagent-status").textContent).toBe("Done · just now");
    expect(tid("subagent-footer").getAttribute("data-status")).toBe("done");
    expect(tid("subagent-footer").textContent).toBe("Worked for 4m 12s·23 tools·48.2K tokens·Opus");
    const tools = [...tid("subagent-pane").querySelectorAll("[data-tool]")];
    expect(tools.map((t) => t.getAttribute("data-tool"))).not.toContain("SubagentHandback");
    expect(tools.find((t) => t.getAttribute("data-tool") === "Bash")?.getAttribute("data-status")).toBe("done");
    expect(tid("subagent-pane").querySelector('[data-testid="thread-text"][data-streaming="true"]')).toBeNull();
    expect(tid("subagent-report").textContent).toBe("Report handed back to Agents panelAdded task frame handling to the thread store with 14 table tests; make check is green.");
    expect(tid("subagent-plate-text").textContent).toBe("Read-only. This agent finished and handed its report to Agents panel.");
  });

  it("a run failing while viewed turns red in place", () => {
    show();
    act(() => {
      setLog([run("a1", { status: "failed", error: "Stopped: the agent was killed", endedAtMs: Date.now() }), NESTED], ITEMS);
    });
    expect(tid("subagent-status").getAttribute("data-status")).toBe("failed");
    expect(tid("subagent-footer").getAttribute("data-status")).toBe("failed");
    expect(tid("subagent-footer").textContent).toContain("Stopped: the agent was killed");
    expect(tid("subagent-plate-text").textContent).toBe("Read-only. This agent failed. Its parent Agents panel was told.");
    expect(screen.queryByTestId("subagent-report")).toBeNull();
  });

  it("names the parent by its current name, its id without one", () => {
    show();
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, s1: { ...s.byId.s1, name: "" } as ThreadView } }));
    });
    expect(tid("subagent-crumb-parent").textContent).toBe("s1");
    expect(tid("thread-user-label").textContent).toBe("Prompt from s1");
  });

  it("a progress tick re-renders the run's own rows, not the work rows", () => {
    show();
    const before = tid("subagent-list").querySelectorAll('[data-row-type="tool"]')[0];
    act(() => {
      setLog([run("a1", { toolUses: 24, activity: "Editing" }), NESTED], ITEMS);
    });
    expect(tid("subagent-footer").textContent).toContain("24 tools");
    expect(tid("subagent-list").querySelectorAll('[data-row-type="tool"]')[0]).toBe(before);
  });

  it("the back buttons, the crumb and the note's links go back up (thread.agent.up)", () => {
    for (const id of ["subagent-back", "subagent-crumb-parent", "subagent-lineage-parent", "subagent-lineage-back", "subagent-plate-back"]) {
      act(() => {
        showAgentRun("s1", "a1");
      });
      const { unmount } = render(<SubagentPane threadId="s1" runId="a1" />);
      fireEvent.click(tid(id));
      expect(getViewing(), id).toBeNull();
      unmount();
    }
    expect(useUiStore.getState().promptFocusSeq).toBe(5);
  });

  it("takes the keyboard when it opens, and Escape goes back up", () => {
    const stop = installKeybindings(window);
    try {
      show();
      expect(document.activeElement).toBe(tid("subagent-pane"));
      fireEvent.keyDown(tid("subagent-pane"), { key: "Escape", code: "Escape" });
      expect(getViewing()).toBeNull();
    } finally {
      stop();
    }
  });
});

describe("ThreadPane", () => {
  it("shows the run in the thread's place while it is viewed, the thread once it is gone", () => {
    render(<ThreadPane threadId="s1" />);
    expect(screen.getByTestId("thread-pane")).toBeTruthy();
    act(() => {
      showAgentRun("s1", "a1");
    });
    expect(screen.queryByTestId("thread-pane")).toBeNull();
    expect(tid("subagent-pane").getAttribute("data-run-id")).toBe("a1");
    // The run leaves the list: back to the thread.
    act(() => {
      setLog([NESTED], ITEMS);
    });
    expect(screen.getByTestId("thread-pane")).toBeTruthy();
    expect(getViewing()).toBeNull();
  });
});

// The mock's a0 and a3 (mock/agents.ts) as e2e/subagent-view.spec.ts opened them.
describe("SubagentPane: the mock's done Explore and failed run", () => {
  const EXPLORE_REPORT = "LinkedPrs in HeaderActions.tsx renders a CommandButton with a count when there are 2+ PRs";

  it("a done foreground Explore: done status, lineage, its explore group, its report shown once as its last text, no report block", () => {
    const a0 = run("a0", { toolUseId: "toolu_a0", description: "Find the header chip pattern", agentType: "Explore", model: "haiku", effort: "", background: false, status: "done", toolUses: 6, totalTokens: 9_400, durationMs: 12_000, summary: EXPLORE_REPORT, startedAtMs: NOW - 330_000, endedAtMs: NOW - 318_000 });
    const explore = tool("toolu_a0", "", { name: "Agent", inputJson: JSON.stringify({ description: "Find the header chip pattern", subagent_type: "Explore", model: "haiku", prompt: "How are the header chips done?" }) });
    setLog(
      [a0],
      [
        user,
        explore,
        tool("g0", "toolu_a0", { name: "Grep", inputJson: JSON.stringify({ pattern: "LinkedPrs|CommandButton", path: "/w/gui/frontend/src" }), output: "HeaderActions.tsx", resultJson: JSON.stringify({ mode: "files_with_matches", numFiles: 3 }) }),
        tool("r0", "toolu_a0", { name: "Read", inputJson: JSON.stringify({ file_path: "/w/gui/frontend/src/components/thread/HeaderActions.tsx" }), resultJson: JSON.stringify({ type: "text", file: { numLines: 112, startLine: 1, totalLines: 112 } }) }),
        text("x0", "toolu_a0", EXPLORE_REPORT),
      ],
    );
    show("a0");
    expect(tid("subagent-name").textContent).toBe("Find the header chip pattern");
    expect(tid("subagent-status").textContent).toBe("Done · 5 min ago");
    expect(tid("subagent-lineage-meta").textContent).toMatch(/^foreground · Explore · Haiku · launched by turn 1's Agent call, [56] min ago$/);
    expect(screen.getByTestId("thread-group").textContent).toBe("Read 1 file, searched code onceHeaderActions.tsx");
    expect(tid("subagent-pane").querySelectorAll("[data-tool]")).toHaveLength(0);
    expect(tid("subagent-footer").getAttribute("data-status")).toBe("done");
    expect(tid("subagent-footer").textContent).toBe("Worked for 12s·6 tools·9.4K tokens·Haiku");
    expect(screen.getAllByTestId("thread-text").map((t) => t.textContent).join("")).toContain(EXPLORE_REPORT);
    expect(screen.queryByTestId("subagent-report")).toBeNull();
    expect(tid("subagent-plate-text").textContent).toBe("Read-only. This agent finished and handed its report to Agents panel.");
  });

  it("a failed run: its two Bash rows, the last one failed; the error in the footer, no report", () => {
    const a3 = run("a3", { toolUseId: "toolu_a3", description: "Screenshot the panel in Wails", agentType: "claude", model: "", background: true, status: "failed", error: "Stopped: process exited with code 1", toolUses: 9, totalTokens: 12_000, durationMs: 63_000, startedAtMs: NOW - 246_000, endedAtMs: NOW - 183_000 });
    setLog(
      [a3],
      [
        user,
        tool("toolu_a3", "", { name: "Agent", status: "error", isError: true, inputJson: JSON.stringify({ description: "Screenshot the panel in Wails", run_in_background: true, prompt: "Screenshot it." }) }),
        tool("b1", "toolu_a3", { inputJson: JSON.stringify({ command: "make gui-build" }), output: "built bin/Code Foundry" }),
        tool("b2", "toolu_a3", { inputJson: JSON.stringify({ command: "open -a 'Code Foundry'" }), status: "error", isError: true, output: "LSOpenURLsWithRole() failed with error -10810 for the application Code Foundry." }),
      ],
    );
    show("a3");
    expect(tid("subagent-status").getAttribute("data-status")).toBe("failed");
    expect(tid("subagent-status").textContent).toBe("Failed · 3 min ago");
    const bash = [...tid("subagent-pane").querySelectorAll('[data-tool="Bash"]')];
    expect(bash).toHaveLength(2);
    expect(bash[1]?.getAttribute("data-status")).toBe("error");
    expect(tid("subagent-footer").getAttribute("data-status")).toBe("failed");
    expect(tid("subagent-footer").textContent).toContain("Stopped: process exited with code 1");
    expect(screen.queryByTestId("subagent-report")).toBeNull();
  });
});
