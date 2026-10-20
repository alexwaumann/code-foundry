import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { ThreadView } from "@/api/threads";

const toast = vi.hoisted(() => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

const { SidePanel } = await import("@/components/panel/SidePanel");
const { getPanel, usePanelStore } = await import("@/stores/panel");
const { useProjectsStore } = await import("@/stores/projects");
const { useThreadsStore } = await import("@/stores/threads");
const { applyWatchBatch, useThreadStore } = await import("@/stores/thread");
const { useUiStore } = await import("@/stores/ui");
const { agentsPanelCommand, showView, useViewsStore } = await import("@/stores/views");
const { useAgentRowIds, useAgentRun } = await import("@/stores/agents");

const thread = (id: string, state = "connected") =>
  ({ id, name: `thread ${id}`, projectId: "web", worktreePath: "/src/web", workspaceId: "", pendingWorktreePath: "", state, status: "idle", linkedPullRequests: [], usage: [], agentRuns: [] }) as unknown as ThreadView;

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
    background: false,
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

/** The sketch's five runs, in spawn order (the nested one started last). */
const RUNS: AgentRunView[] = [
  run("a0", { description: "Find the header chip pattern", agentType: "Explore", model: "haiku", status: "done", summary: "LinkedPrs renders a CommandButton.", durationMs: 12_000, toolUses: 6, totalTokens: 9_400, endedAtMs: NOW - 5 * 60_000 }),
  run("a1", { description: "PR 1", model: "opus", effort: "high", background: true, activity: "Running go test", lastTool: "Bash", toolUses: 23, totalTokens: 48_200, startedAtMs: NOW - 252_000 }),
  run("a2", { description: "PR 2", model: "opus", effort: "high", background: true, activity: "Editing AgentsSurface.tsx", lastTool: "Edit" }),
  run("a3", { description: "Screenshot", agentType: "claude", background: true, status: "failed", error: "Stopped: process exited with code 1", durationMs: 63_000, endedAtMs: NOW - 3 * 60_000 }),
  run("a1b", { description: "Review", agentType: "Explore", parentId: "a1", spawnDepth: 2, activity: "Reading usage_runs.go", lastTool: "Read" }),
];

/** The runs in the thread log (the tab's rows) and in the thread list (the surface's availability), like the daemon publishes them. */
function setAgents(id: string, agents: AgentRunView[]): void {
  useThreadStore.setState((s) => ({ logs: { ...s.logs, [id]: { seq: 1, byId: {}, order: [], pending: [], mcp: null, commands: [], agents } } }));
  setListRuns(id, agents.length);
}

/** The thread list's agentRuns: only their count matters to the surface. */
function setListRuns(id: string, n: number): void {
  useThreadsStore.setState((s) => {
    const t = s.byId[id];
    if (!t) return s;
    const agentRuns = Array.from({ length: n }, (_, i) => ({ id: `r${String(i)}` })) as unknown as ThreadView["agentRuns"];
    return { byId: { ...s.byId, [id]: { ...t, agentRuns } } };
  });
}

const rows = () => screen.getAllByTestId("agent-row");
const rowOf = (id: string) => rows().find((r) => r.getAttribute("data-agent") === id) as HTMLElement;
const within = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`);
const entry = () => screen.queryByTestId("panel-empty")?.querySelector('[data-surface="agents"]') ?? null;

beforeEach(() => {
  useProjectsStore.setState({ byId: {}, order: [] });
  useThreadsStore.setState({ byId: { "s-r": thread("s-r"), "s-off": thread("s-off", "disconnected") }, order: ["s-r", "s-off"] });
  usePanelStore.setState({ byKey: { "thread:s-r": { open: true, groups: [{ tabs: [], activeTabId: null }] }, "view:projects": { open: true, groups: [{ tabs: [], activeTabId: null }] } } });
  useViewsStore.setState({ settingsOpen: false });
  useUiStore.setState({ windowWidth: 1400, sidebarVisible: true, sidebarWidth: 260, selection: { kind: "thread", id: "s-r" }, palette: { ...useUiStore.getState().palette, open: false } });
  useThreadStore.setState({ logs: {} });
  setAgents("s-r", RUNS);
  toast.mockClear();
});

afterEach(cleanup);

describe("Agents surface", () => {
  it("is listed with A for a thread with runs and hidden for a page", () => {
    render(<SidePanel />);
    expect(entry()?.getAttribute("data-availability")).toBe("enabled");
    expect(entry()?.textContent).toContain("Agents");
    act(() => {
      useUiStore.setState({ selection: { kind: "view", name: "projects" } });
    });
    expect(entry()).toBeNull();
    expect(agentsPanelCommand()).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });

  it("is hidden for a thread without runs, listed live once its first run starts; A does nothing meanwhile", () => {
    setAgents("s-r", []);
    render(<SidePanel />);
    expect(entry()).toBeNull();
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "a" });
    expect(getPanel("thread:s-r").groups[0]?.activeTabId).toBeNull();
    act(() => {
      setListRuns("s-r", 1);
    });
    expect(entry()?.getAttribute("data-availability")).toBe("enabled");
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "a" });
    expect(getPanel("thread:s-r").groups[0]?.activeTabId).toBe("agents");
  });

  it("view.panel.agents opens the tab for a thread with runs; without runs it toasts and opens nothing", () => {
    usePanelStore.setState({ byKey: {} });
    expect(agentsPanelCommand()).toBe(true);
    expect(getPanel("thread:s-r")).toMatchObject({ open: true, groups: [{ activeTabId: "agents" }] });
    expect(toast).not.toHaveBeenCalled();
    setAgents("s-r", []);
    usePanelStore.setState({ byKey: {} });
    expect(showView("panel.agents")).toBe(true);
    expect(getPanel("thread:s-r").open).toBe(false);
    expect(toast).toHaveBeenCalledWith("No agents yet", expect.anything());
  });

  it("an open tab stays when the surface would be hidden: only the empty list's row goes", () => {
    act(() => {
      showView("panel.agents");
    });
    setAgents("s-r", []);
    render(<SidePanel />);
    expect(getPanel("thread:s-r").groups[0]?.activeTabId).toBe("agents");
    expect(screen.getByTestId("agents-empty")).toBeTruthy();
  });

  it("A opens it: the header counts, rows in spawn order with the nested run under its parent", () => {
    render(<SidePanel />);
    fireEvent.keyDown(screen.getByTestId("side-panel"), { key: "a" });
    expect(getPanel("thread:s-r").groups[0]?.activeTabId).toBe("agents");
    expect(screen.getByTestId("agents-count").textContent).toBe("3 running · 5 this thread");
    expect(screen.getByTestId("agents-subline").textContent).toBe("2 in the background keep running after the turn ends");
    expect(rows().map((r) => [r.getAttribute("data-agent"), r.getAttribute("data-level"), r.getAttribute("data-status")])).toEqual([
      ["a0", "0", "done"],
      ["a1", "0", "running"],
      ["a1b", "1", "running"],
      ["a2", "0", "running"],
      ["a3", "0", "failed"],
    ]);
    // The nested run is indented with a connector.
    expect(rowOf("a1b").className).toContain("cf-agents-nest");
    expect(rowOf("a1b").style.paddingLeft).toBe("36px");
    expect(rowOf("a1").className).not.toContain("cf-agents-nest");
  });

  it("shows every state: running activity, a done run's report, a failed run's error, the stats", () => {
    act(() => {
      showView("panel.agents");
    });
    render(<SidePanel />);
    expect(rows().map((r) => within(r, "agent-status")?.textContent)).toEqual(["Done · 5 min ago", "Running", "Running", "Running", "Failed · 3 min ago"]);
    expect(within(rowOf("a0"), "agent-meta")?.textContent).toBe("Explore·haiku·foreground");
    expect(within(rowOf("a1"), "agent-meta")?.textContent).toBe("general-purpose·opus·high·background");
    expect(within(rowOf("a0"), "agent-summary")?.textContent).toBe("LinkedPrs renders a CommandButton.");
    expect(within(rowOf("a0"), "agent-activity")).toBeNull();
    expect(within(rowOf("a1"), "agent-activity")?.textContent).toBe("Running go testBash");
    expect(within(rowOf("a1"), "agent-summary")).toBeNull();
    expect(within(rowOf("a3"), "agent-error")?.textContent).toBe("Stopped: process exited with code 1");
    expect(within(rowOf("a3"), "agent-error")?.className).toContain("text-destructive");
    expect(within(rowOf("a0"), "agent-elapsed")?.textContent).toBe("12s");
    expect(within(rowOf("a0"), "agent-tools")?.textContent).toBe("6");
    expect(within(rowOf("a0"), "agent-tokens")?.textContent).toBe("9.4K");
    expect(within(rowOf("a1"), "agent-elapsed")?.textContent).toMatch(/^4m 1\ds$/);
    expect(within(rowOf("a1"), "agent-tokens")?.textContent).toBe("48.2K");
    // Running rows spin; ended ones get a dot. Rows are not clickable.
    expect(rowOf("a1").querySelector('[aria-label="Running"]')).not.toBeNull();
    expect(rowOf("a3").querySelector(".bg-destructive")).not.toBeNull();
    expect(rowOf("a0").querySelector(".bg-success")).not.toBeNull();
    expect(screen.getByTestId("agents-surface").querySelectorAll("button")).toHaveLength(0);
  });

  it("empty and quiet states (a tab opened before, e.g. restored with the panel)", () => {
    act(() => {
      showView("panel.agents");
    });
    setAgents("s-r", []);
    render(<SidePanel />);
    expect(screen.getByTestId("agents-empty").textContent).toBe("No agents yet. Claude's subagents (the Agent tool) show here as they run.");
    expect(screen.queryByTestId("agents-count")).toBeNull();
    act(() => {
      setAgents("s-r", [run("x", { status: "done", endedAtMs: NOW })]);
    });
    expect(screen.getByTestId("agents-count").textContent).toBe("0 running · 1 this thread");
    expect(screen.getByTestId("agents-subline").textContent).toBe("No agents running");
  });

  it("a run's update re-renders its row only; the list follows a new run", () => {
    const renders: Record<string, number> = {};
    function Row({ id }: { id: string }) {
      useAgentRun("s-r", id);
      renders[id] = (renders[id] ?? 0) + 1;
      return null;
    }
    let listRenders = 0;
    function List() {
      const ids = useAgentRowIds("s-r");
      listRenders++;
      return (
        <>
          {ids.map((id) => (
            <Row key={id} id={id} />
          ))}
        </>
      );
    }
    render(<List />);
    const before = { ...renders };
    const listBefore = listRenders;
    // A progress event: only a1's activity changes (the list arrives whole, like the daemon's).
    act(() => {
      applyWatchBatch("s-r", [{ kind: "agents", threadId: "s-r", seq: 2, agents: RUNS.map((r) => (r.id === "a1" ? { ...r, activity: "Running go vet" } : { ...r })) }]);
    });
    expect(renders.a1).toBe((before.a1 ?? 0) + 1);
    for (const id of ["a0", "a1b", "a2", "a3"]) expect(renders[id]).toBe(before[id]);
    expect(listRenders).toBe(listBefore);
    // A new run: the list re-renders.
    act(() => {
      applyWatchBatch("s-r", [{ kind: "agents", threadId: "s-r", seq: 3, agents: [...RUNS, run("a5")] }]);
    });
    expect(listRenders).toBe(listBefore + 1);
  });

  it("a disconnected thread still lists its runs; no thread selected says so", () => {
    setAgents("s-off", [run("z", { status: "failed", error: "the daemon stopped before the agent finished", endedAtMs: NOW })]);
    usePanelStore.setState((s) => ({ byKey: { ...s.byKey, "thread:s-off": { open: true, groups: [{ tabs: [], activeTabId: null }] } } }));
    act(() => {
      useUiStore.setState({ selection: { kind: "thread", id: "s-off" } });
      showView("panel.agents");
    });
    render(<SidePanel />);
    expect(rows().map((r) => r.getAttribute("data-agent"))).toEqual(["z"]);
  });
});
