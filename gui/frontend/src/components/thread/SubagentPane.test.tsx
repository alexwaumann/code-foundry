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
const { inPalette, installKeybindings, isStartable } = await import("@/keys/bindings");
const { insertTagInto } = await import("@/stores/cite");
const { getDraft } = await import("@/stores/compose");
const { putInThreadComposer } = await import("@/stores/composerText");
const { presentDictationToggle } = await import("@/stores/dictation");
const { historyComposer, presentPromptHistory } = await import("@/stores/historyComposers");
const { threadDraftKey } = await import("@/lib/threadDraft");
const { useCommandsStore } = await import("@/stores/commands");
const { getViewing, showAgentRun, useSubagentViewStore } = await import("@/stores/subagentView");
const { useCardRoom } = await import("@/stores/threadInfoOverlay");
const { useThreadStore } = await import("@/stores/thread");
const { useThreadsStore } = await import("@/stores/threads");
const { useUiStore } = await import("@/stores/ui");

/** The read-only subagent view (SubagentPane.tsx): header, lineage, prompt, turn header, work, report, composer stand-in, Escape. */

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
  useUiStore.setState({ selection: { kind: "thread", id: "s1" }, promptFocusSeq: 0, palette: { ...useUiStore.getState().palette, open: false } });
  useCommandsStore.setState({ commands: [cmd("thread.agent.up", { keybindings: ["escape"] }), cmd("thread.agent.open"), cmd("view.panel.toggle"), cmd("view.bottom.toggle"), cmd("view.thread-info"), cmd("thread.archive"), cmd("thread.rename")] });
  useSubagentViewStore.setState({ viewing: null, focusSeq: 0 });
  useThreadStore.setState({ folds: {} });
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
  const head = () => tid("thread-turn-header");
  const rowTypes = () => [...tid("subagent-list").querySelectorAll("[data-row-type]")].map((r) => r.getAttribute("data-row-type"));
  const say = () => tid("subagent-composer-text").textContent;

  it("a running run: crumb, the thread info toggle, lineage, plain prompt, live turn header above its rows, composer card", () => {
    show();
    expect(tid("subagent-crumb-parent").textContent).toBe("Agents panel");
    expect(tid("subagent-name").textContent).toBe("PR 1: daemon task frames");
    // No thread actions: no title menu; a thread's three toggles.
    expect(screen.queryByTestId("thread-title")).toBeNull();
    expect([...tid("pane-actions").querySelectorAll("button")].map((b) => b.getAttribute("data-testid"))).toEqual(["thread-info-toggle"]);
    expect(tid("subagent-lineage-parent").textContent).toBe("Agents panel");
    expect(tid("subagent-lineage-meta").textContent).toBe("background · general-purpose · Opus · high · launched by turn 1's Agent call, 4m ago");
    expect(tid("subagent-prompt").textContent).toContain(PROMPT);
    expect(tid("subagent-prompt").textContent).not.toContain("Prompt from");
    // The run's own items only (not the parent's message, not the nested run's), in order, under the header.
    expect(rowTypes()).toEqual(["lineage", "prompt", "head", "tool", "tool", "text"]);
    // The nested Agent call shows with its run's chips, not openable, one line with nothing under it.
    const nested = screen.getAllByTestId("thread-tool")[1]?.closest("[data-tool]");
    expect(nested?.getAttribute("data-tool")).toBe("Agent");
    expect(nested?.querySelector('[data-testid="thread-agent-open"]')).toBeNull();
    expect(nested?.querySelector('[data-testid="thread-tool"]')?.tagName).toBe("DIV");
    expect(nested?.querySelectorAll("[data-tool]")).toHaveLength(0);
    expect(head().hasAttribute("data-live")).toBe(true);
    expect(head().querySelector("button")).toBeNull();
    expect(head().textContent).toMatch(/^Working for 4m 1\ds·23 tools·48\.2K tokens·Opus$/);
    expect(say()).toBe("Subagents take instructions from Agents panel, so this one cannot be steered.");
    expect(tid("subagent-composer-chord").textContent).toBe("esc");
    expect(tid("subagent-composer-back").textContent).toContain("Back to Agents panel");
    expect(screen.queryByTestId("subagent-report")).toBeNull();
  });

  it("the composer's chips are facts: the run's model, its effort, its type, no controls", () => {
    show();
    expect(tid("subagent-model").textContent).toBe("Opus");
    expect(tid("subagent-effort").textContent).toBe("High");
    expect(tid("subagent-type").textContent).toBe("general-purpose");
    expect([...tid("subagent-composer").querySelectorAll("button, input, [contenteditable]")].map((b) => b.getAttribute("data-testid"))).toEqual(["subagent-composer-back"]);
  });

  it("a run without a model, effort or type: the thread's model, no empty chips", () => {
    setLog([run("a1", { model: "", effort: "", agentType: "" }), NESTED], ITEMS);
    show();
    expect(tid("subagent-model").textContent).toBe("Opus 4.8");
    expect(screen.queryByTestId("subagent-effort")).toBeNull();
    expect(screen.queryByTestId("subagent-type")).toBeNull();
  });

  it("a done run folds to its header and answer; the chevron opens its work and the choice is kept for the visit", () => {
    setLog([run("a1", { status: "done", durationMs: 38_000, toolUses: 4, totalTokens: 6_100, endedAtMs: NOW - 5 * 60_000, summary: "Tests pass" }), NESTED], ITEMS);
    const { unmount } = show();
    expect(head().textContent).toBe("Worked for 38s·4 tools·6.1K tokens·Opus");
    expect(head().getAttribute("data-folded")).toBe("true");
    // Its report is its last text: shown once, the rest of its work folded.
    expect(rowTypes()).toEqual(["lineage", "prompt", "head", "text"]);
    expect(screen.queryByTestId("subagent-report")).toBeNull();
    expect(say()).toBe("This agent finished and handed its report to Agents panel.");
    fireEvent.click(screen.getByRole("button", { name: "Show this agent's work" }));
    expect(rowTypes()).toEqual(["lineage", "prompt", "head", "tool", "tool", "text"]);
    unmount();
    show();
    expect(head().hasAttribute("data-folded")).toBe(false);
  });

  it("a done run whose report is not its last text: the report stands for it folded, and follows its work open", () => {
    setLog([run("a1", { status: "done", summary: "Added the task frames." }), NESTED], ITEMS);
    show();
    expect(rowTypes()).toEqual(["lineage", "prompt", "head", "report"]);
    expect(tid("subagent-report").textContent).toBe("Added the task frames.");
    fireEvent.click(head().querySelector("button") as HTMLButtonElement);
    expect(rowTypes()).toEqual(["lineage", "prompt", "head", "tool", "tool", "text", "report"]);
  });

  it("a done run with nothing to fold: its header is plain text", () => {
    setLog([run("a1", { status: "done", summary: "Tests pass" })], [user, call("a1"), text("t1", "toolu_a1", "Tests pass")]);
    show();
    expect(head().querySelector("button")).toBeNull();
    expect(rowTypes()).toEqual(["lineage", "prompt", "head", "text"]);
  });

  it("a failed run: a red header, its error in view while folded, the composer says so", () => {
    setLog([run("a1", { status: "failed", error: "Stopped: process exited with code 1", durationMs: 63_000, endedAtMs: NOW - 3 * 60_000 }), NESTED], ITEMS);
    show();
    expect(head().getAttribute("data-status")).toBe("failed");
    expect(head().textContent).toContain("Failed after 1m 3s");
    expect(head().querySelector(".t-red")?.textContent).toBe("Failed after 1m 3s");
    expect(tid("subagent-error").textContent).toBe("Stopped: process exited with code 1");
    expect(tid("subagent-error").getAttribute("role")).toBe("alert");
    expect(say()).toBe("This agent failed, and Agents panel was told.");
  });

  it("a failed run without an error: the header alone says it", () => {
    setLog([run("a1", { status: "failed" }), NESTED], ITEMS);
    show();
    expect(head().textContent).toContain("Failed");
    expect(screen.queryByTestId("subagent-error")).toBeNull();
  });

  it("the run ending while viewed turns the view done in place: its running tool stops, the handback call is no row, the report shows", () => {
    show();
    const handback = tool("h1", "toolu_a1", { name: "SubagentHandback", inputJson: JSON.stringify({ message: "Added task frame handling." }) });
    act(() => {
      setLog(
        [run("a1", { status: "done", durationMs: 252_000, endedAtMs: Date.now(), summary: "Added task frame handling to the thread store with 14 table tests; make check is green." }), NESTED],
        [...ITEMS.map((it) => (it.id === "b1" ? { ...it, status: "done" } as ThreadItemView : it)), handback],
      );
    });
    expect(head().getAttribute("data-status")).toBe("done");
    expect(head().textContent).toBe("Worked for 4m 12s·23 tools·48.2K tokens·Opus");
    fireEvent.click(head().querySelector("button") as HTMLButtonElement);
    const tools = [...tid("subagent-pane").querySelectorAll("[data-tool]")];
    expect(tools.map((t) => t.getAttribute("data-tool"))).not.toContain("SubagentHandback");
    expect(tools.find((t) => t.getAttribute("data-tool") === "Bash")?.getAttribute("data-status")).toBe("done");
    expect(tid("subagent-pane").querySelector('[data-testid="thread-text"][data-streaming="true"]')).toBeNull();
    expect(tid("subagent-report").textContent).toBe("Added task frame handling to the thread store with 14 table tests; make check is green.");
    expect(say()).toBe("This agent finished and handed its report to Agents panel.");
  });

  it("a run failing while viewed turns red in place", () => {
    show();
    act(() => {
      setLog([run("a1", { status: "failed", error: "Stopped: the agent was killed", endedAtMs: Date.now() }), NESTED], ITEMS);
    });
    expect(head().getAttribute("data-status")).toBe("failed");
    expect(tid("subagent-error").textContent).toBe("Stopped: the agent was killed");
    expect(say()).toBe("This agent failed, and Agents panel was told.");
    expect(screen.queryByTestId("subagent-report")).toBeNull();
  });

  it("names the parent by its current name, its id without one", () => {
    show();
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, s1: { ...s.byId.s1, name: "" } as ThreadView } }));
    });
    expect(tid("subagent-crumb-parent").textContent).toBe("s1");
    expect(tid("subagent-composer-back").textContent).toContain("Back to s1");
  });

  it("a progress tick re-renders the run's own rows, not the work rows", () => {
    show();
    const before = tid("subagent-list").querySelectorAll('[data-row-type="tool"]')[0];
    act(() => {
      setLog([run("a1", { toolUses: 24, activity: "Editing" }), NESTED], ITEMS);
    });
    expect(head().textContent).toContain("24 tools");
    expect(tid("subagent-list").querySelectorAll('[data-row-type="tool"]')[0]).toBe(before);
  });

  it("the crumb, the note's name and the composer's Back go back up (thread.agent.up)", () => {
    for (const id of ["subagent-crumb-parent", "subagent-lineage-parent", "subagent-composer-back"]) {
      act(() => {
        showAgentRun("s1", "a1");
      });
      const { unmount } = render(<SubagentPane threadId="s1" runId="a1" />);
      fireEvent.click(tid(id));
      expect(getViewing(), id).toBeNull();
      unmount();
    }
    expect(useUiStore.getState().promptFocusSeq).toBe(3);
  });

  it("Escape closes the floating card first, and only then goes up", () => {
    const stop = installKeybindings(window);
    try {
      show();
      act(() => {
        useCardRoom.setState({ room: false, overlayFor: "s1" });
      });
      fireEvent.keyDown(tid("subagent-pane"), { key: "Escape", code: "Escape" });
      expect(getViewing()).not.toBeNull();
      act(() => {
        useCardRoom.setState({ room: true, overlayFor: null });
      });
      fireEvent.keyDown(tid("subagent-pane"), { key: "Escape", code: "Escape" });
      expect(getViewing()).toBeNull();
    } finally {
      stop();
    }
  });

  it("the crumb takes no move: a no-project thread's place is plain text here", () => {
    show();
    expect(screen.queryByTestId("thread-crumb-move")).toBeNull();
    expect(tid("thread-crumb").querySelectorAll("button")).toHaveLength(1);
  });

  it("nothing aimed at a composer lands: no drop target, no dictation target, no cite target, no history picker", () => {
    show();
    expect(tid("subagent-pane").querySelector("[data-file-drop-target]")).toBeNull();
    expect(tid("subagent-pane").querySelector("[contenteditable]")).toBeNull();
    expect(screen.queryByTestId("thread-composer")).toBeNull();
    expect(presentDictationToggle()).toBe(false);
    expect(insertTagInto(threadDraftKey("s1"), { tagKind: "file", projectId: "r1", path: "a.go" })).toBe(false);
    expect(historyComposer(threadDraftKey("s1"))).toBeUndefined();
    const open = vi.spyOn(useUiStore.getState(), "openPromptsPalette");
    presentPromptHistory();
    expect(open).not.toHaveBeenCalled();
    open.mockRestore();
  });

  it("a request for the prompt leaves the keyboard in the view, so Escape still works", () => {
    show();
    (document.activeElement as HTMLElement).blur();
    act(() => {
      useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
    });
    expect(document.activeElement).toBe(tid("subagent-pane"));
    (document.activeElement as HTMLElement).blur();
    act(() => {
      useUiStore.setState((s) => ({ contentFocusSeq: s.contentFocusSeq + 1 }));
    });
    expect(document.activeElement).toBe(tid("subagent-pane"));
  });

  it("the thread's verbs do not start from the keyboard or the palette here; viewing ones do", () => {
    show();
    const commands = useCommandsStore.getState().commands;
    const named = (n: string) => commands.find((c) => c.name === n) as CommandView;
    expect(isStartable(named("thread.rename"))).toBe(false);
    expect(inPalette(named("thread.archive"))).toBe(false);
    expect(isStartable(named("view.thread-info"))).toBe(true);
    act(() => {
      useSubagentViewStore.setState({ viewing: null });
    });
    expect(isStartable(named("thread.rename"))).toBe(true);
  });

  it("Ask Claude from a page goes back up to the prompt the text went to", () => {
    show();
    act(() => {
      putInThreadComposer("s1", "fix these errors");
    });
    expect(getViewing()).toBeNull();
    expect(getDraft(threadDraftKey("s1")).text).toContain("fix these errors");
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
    expect(tid("subagent-lineage-meta").textContent).toMatch(/^foreground · Explore · Haiku · launched by turn 1's Agent call, [56]m ago$/);
    expect(tid("thread-turn-header").textContent).toBe("Worked for 12s·6 tools·9.4K tokens·Haiku");
    fireEvent.click(screen.getByRole("button", { name: "Show this agent's work" }));
    expect(screen.getByTestId("thread-group").textContent).toBe("Read 1 file, searched code onceHeaderActions.tsx");
    expect(tid("subagent-pane").querySelectorAll("[data-tool]")).toHaveLength(0);
    expect(screen.getAllByTestId("thread-text").map((t) => t.textContent).join("")).toContain(EXPLORE_REPORT);
    expect(screen.queryByTestId("subagent-report")).toBeNull();
    expect(tid("subagent-composer-text").textContent).toBe("This agent finished and handed its report to Agents panel.");
  });

  it("a failed run: its two Bash rows, the last one failed; the error under them, no report", () => {
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
    expect(tid("thread-turn-header").getAttribute("data-status")).toBe("failed");
    fireEvent.click(screen.getByRole("button", { name: "Show this agent's work" }));
    const bash = [...tid("subagent-pane").querySelectorAll('[data-tool="Bash"]')];
    expect(bash).toHaveLength(2);
    expect(bash[1]?.getAttribute("data-status")).toBe("error");
    expect(tid("subagent-error").textContent).toBe("Stopped: process exited with code 1");
    expect(screen.queryByTestId("subagent-report")).toBeNull();
  });
});
