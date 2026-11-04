import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { StreamStatus } from "@/api/stream";
import type { BackgroundShellView, ThreadView } from "@/api/threads";
import type { WakeKind, WakeSubscriptionView } from "@/api/wakes";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useCommandsStore } from "@/stores/commands";
import { applyThreadEvent, useThreadStore } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";

const { run, openAgentRun } = vi.hoisted(() => ({ run: vi.fn(), openAgentRun: vi.fn() }));
vi.mock("@/stores/commands", async (orig) => ({ ...(await orig<typeof import("@/stores/commands")>()), runCommandForResult: run }));
vi.mock("@/stores/subagentActions", async (orig) => ({ ...(await orig<typeof import("@/stores/subagentActions")>()), openAgentRun }));

const { WaitingStrip } = await import("./WaitingStrip");

const wake = (id: string, kind: WakeKind, o: Partial<WakeSubscriptionView> = {}): WakeSubscriptionView => ({
  id,
  kind,
  targetId: id,
  targetName: id,
  targetStatus: "",
  condition: "settled",
  note: "",
  ...o,
});

const shell = (taskId: string, command: string): BackgroundShellView => ({ taskId, command, description: "", startedAtMs: 1, ports: [] });

const agent = (id: string, o: Partial<AgentRunView> = {}) => ({ id, description: id, agentType: "general-purpose", background: true, spawnDepth: 1, status: "running", activity: "", ...o }) as AgentRunView;

const thread = (id: string, o: Partial<ThreadView> = {}) =>
  ({ id, name: id, projectId: "", worktreePath: "/w", state: "connected", status: "idle", statusReason: "at prompt", statusChangedAtMs: null, archivedAtMs: null, busyTool: "", flags: [], backgroundShells: [], ...o }) as unknown as ThreadView;

function setup(o: { wakes?: WakeSubscriptionView[]; shells?: BackgroundShellView[]; agents?: AgentRunView[]; self?: Partial<ThreadView>; others?: ThreadView[]; synced?: boolean; watch?: StreamStatus }) {
  const others = o.others ?? [];
  useThreadsStore.setState({
    byId: { s: thread("s", { backgroundShells: o.shells ?? [], ...o.self }), ...Object.fromEntries(others.map((t) => [t.id, t])) },
    order: ["s", ...others.map((t) => t.id)],
  });
  useThreadStore.setState({
    logs: { s: { seq: 1, byId: {}, order: [], pending: [], mcp: null, commands: [], agents: o.agents ?? [], wakes: o.wakes ?? [] } },
    synced: o.synced === false ? {} : { s: true },
    watches: { s: { status: o.watch ?? "open", error: null } },
  });
  render(
    <TooltipProvider>
      <WaitingStrip threadId="s" />
    </TooltipProvider>,
  );
}

const expand = () => {
  fireEvent.click(screen.getByTestId("waiting-toggle"));
};
const rows = () => screen.getAllByTestId("waiting-row");
const rowOf = (id: string) => {
  const row = rows().find((r) => r.dataset.wake === id);
  if (!row) throw new Error(`no row ${id}`);
  return row;
};

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ message: "" });
  openAgentRun.mockReset();
  useCommandsStore.setState({ commands: [{ name: "thread.agent.open", title: "", available: true, args: [], keybindings: [] } as never] });
});

afterEach(() => {
  cleanup();
});

describe("WaitingStrip", () => {
  it("shows for a wake on a thread that reads plain idle, collapsed", () => {
    setup({ wakes: [wake("sub-1", "pullRequest")] });
    expect(screen.getByTestId("waiting-sentence").textContent).toBe("Waiting on 1 PR");
    expect(screen.queryByTestId("waiting-row")).toBeNull();
  });

  it.each([
    ["with nothing to wake it", {}],
    ["on an archived thread", { wakes: [wake("sub-1", "timer")], self: { archivedAtMs: 1 } }],
  ])("is not there %s", (_name, o) => {
    setup(o);
    expect(screen.queryByTestId("waiting-strip")).toBeNull();
  });

  // A closed Watch keeps its log for the next visit: rows from then must not show as current.
  const stale = { wakes: [wake("sub-1", "timer")], shells: [shell("b1", "npm run dev")], agents: [agent("a1")] };
  it.each([
    ["before this Watch's snapshot", { ...stale, synced: false, watch: "connecting" as const }],
    ["while its Watch cannot open", { ...stale, synced: false, watch: "retrying" as const }],
    ["while a Watch that opened is failing", { ...stale, watch: "retrying" as const }],
    ["after its Watch stopped for good", { ...stale, watch: "stopped" as const }],
  ])("shows no rows and no Stop waiting %s", (_name, o) => {
    setup(o);
    expect(screen.queryByTestId("waiting-strip")).toBeNull();
    expect(screen.queryByTestId("waiting-stop")).toBeNull();
  });

  it("keeps its rows through a resync, and the snapshot then replaces them", () => {
    setup({ ...stale, watch: "connecting" });
    expect(screen.getByTestId("waiting-sentence").textContent).toBe("Waiting on 1 timer, 1 shell and 1 subagent");
  });

  it("comes up, expanded state kept, once the failing Watch recovers", () => {
    setup({ wakes: [wake("sub-1", "timer")] });
    expand();
    act(() => {
      useThreadStore.setState({ watches: { s: { status: "retrying", error: null } } });
    });
    expect(screen.queryByTestId("waiting-strip")).toBeNull();
    act(() => {
      useThreadStore.setState({ watches: { s: { status: "open", error: null } } });
    });
    expect(rows().map((r) => r.dataset.wake)).toEqual(["sub-1"]);
  });

  it("is not there for finished subagents", () => {
    setup({ agents: [agent("a1", { status: "done" })] });
    expect(screen.queryByTestId("waiting-strip")).toBeNull();
  });

  it("says everything in one line and rows go in the same order", () => {
    setup({
      wakes: [wake("t1", "timer"), wake("p1", "pullRequest"), wake("th1", "thread"), wake("th2", "thread")],
      shells: [shell("b1", "npm run dev")],
      agents: [agent("a1")],
    });
    expect(screen.getByTestId("waiting-sentence").textContent).toBe("Waiting on 2 threads, 1 PR, 1 timer, 1 shell and 1 subagent");
    expand();
    expect(rows().map((r) => r.dataset.kind)).toEqual(["thread", "thread", "pullRequest", "timer", "shell", "subagent"]);
  });

  it("a thread row follows the thread itself, live", () => {
    setup({ wakes: [wake("sub-1", "thread", { targetId: "c", targetName: "old", targetStatus: "busy (working)" })], others: [thread("c", { name: "Child", status: "busy", statusReason: "working", busyTool: "Bash make check" })] });
    expand();
    const row = () => within(rowOf("sub-1"));
    expect(row().getByTestId("waiting-row-name").textContent).toBe("Child");
    expect(row().getByTestId("waiting-row-status").textContent).toBe("Working · Bash make check");
    act(() => {
      useThreadsStore.setState((s) => ({ byId: { ...s.byId, c: thread("c", { name: "Child", statusReason: "waiting on 1 subagent" }) } }));
    });
    expect(row().getByTestId("waiting-row-status").textContent).toBe("Waiting on 1 subagent");
  });

  it("a thread gone from the list reads the daemon's words", () => {
    setup({ wakes: [wake("sub-1", "thread", { targetId: "gone", targetName: "Child", targetStatus: "gone" })] });
    expand();
    expect(within(rowOf("sub-1")).getByTestId("waiting-row-status").textContent).toBe("gone");
  });

  it("a timer row is named by its reason; a pull request's status drops open", () => {
    setup({ wakes: [wake("t", "timer", { note: "Check the deploy", targetName: "at 15:30", targetStatus: "next 15:30" }), wake("p", "pullRequest", { targetName: "a/b#1 Rotate", targetStatus: "open · checks pending (2/4)" })] });
    expand();
    expect(within(rowOf("t")).getByTestId("waiting-row-name").textContent).toBe("Check the deploy");
    expect(within(rowOf("t")).getByTestId("waiting-row-status").textContent).toBe("next 15:30");
    expect(within(rowOf("p")).getByTestId("waiting-row-status").textContent).toBe("checks pending (2/4)");
  });

  it("two subscriptions to one target name their conditions", () => {
    setup({ wakes: [wake("a", "pullRequest", { targetId: "o/r#1", targetName: "o/r#1", condition: "review" }), wake("b", "pullRequest", { targetId: "o/r#1", targetName: "o/r#1", condition: "merged" })] });
    expect(screen.getByTestId("waiting-sentence").textContent).toBe("Waiting on 1 PR");
    expand();
    expect(rows().map((r) => within(r).getByTestId("waiting-row-name").textContent)).toEqual(["o/r#1 · review", "o/r#1 · merged"]);
  });

  it("the × runs thread.unsubscribe by id, once, and the row leaves with the next list", async () => {
    setup({ wakes: [wake("sub-1", "timer"), wake("sub-2", "pullRequest")] });
    expand();
    const remove = within(rowOf("sub-1")).getByTestId<HTMLButtonElement>("waiting-remove");
    fireEvent.click(remove);
    fireEvent.click(remove);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("thread.unsubscribe", { subscription: "sub-1" }, expect.objectContaining({ quiet: true }));
    expect(screen.getAllByTestId("waiting-row")).toHaveLength(2); // the daemon says when it is gone
    act(() => {
      useThreadStore.setState((s) => ({ logs: { s: applyThreadEvent(s.logs.s, { kind: "wakes", threadId: "s", wakes: [wake("sub-2", "pullRequest")] }) as NonNullable<(typeof s.logs)["s"]> } }));
    });
    await waitFor(() => {
      expect(rows().map((r) => r.dataset.wake)).toEqual(["sub-2"]);
    });
    expect(screen.getByTestId("waiting-sentence").textContent).toBe("Waiting on 1 PR");
  });

  it("a failed × can be pressed again", async () => {
    run.mockResolvedValueOnce(null);
    setup({ wakes: [wake("sub-1", "timer")] });
    expand();
    const remove = screen.getByTestId<HTMLButtonElement>("waiting-remove");
    fireEvent.click(remove);
    await waitFor(() => {
      expect(remove.disabled).toBe(false);
    });
  });

  it("a shell row has Stop, not ×, and holds until the shell goes", async () => {
    setup({ shells: [shell("b1", "npm run dev\nmore")] });
    expand();
    const row = within(rowOf("b1"));
    expect(row.getByTestId("waiting-row-name").textContent).toBe("npm run dev …");
    expect(row.queryByTestId("waiting-remove")).toBeNull();
    fireEvent.click(row.getByTestId("waiting-stop-shell"));
    expect(run).toHaveBeenCalledWith("thread.shell.stop", { id: "s", task: "b1" }, expect.objectContaining({ quiet: true }));
    await waitFor(() => {
      expect(row.getByTestId("waiting-row-status").textContent).toBe("stopping");
    });
    expect(row.getByTestId<HTMLButtonElement>("waiting-stop-shell").disabled).toBe(true);
  });

  it("a subagent row has no action: its name opens the run, its activity shows, and it says so", () => {
    setup({ agents: [agent("a1", { description: "Review usage", activity: "Running go test" })] });
    expand();
    const row = within(rowOf("a1"));
    expect(row.getByTestId("waiting-row-status").textContent).toBe("Running go test");
    expect(row.getByText("runs to its end")).toBeTruthy();
    expect(row.queryByRole("button", { name: /stop/i })).toBeNull();
    expect(row.queryByTestId("waiting-remove")).toBeNull();
    fireEvent.click(row.getByTestId("waiting-subagent-name"));
    expect(openAgentRun).toHaveBeenCalledWith("s", "a1");
  });

  it("a subagent's name is plain text where thread.agent.open is not listed; no activity reads running", () => {
    useCommandsStore.setState({ commands: [] });
    setup({ agents: [agent("a1", { description: "Review usage" })] });
    expand();
    const row = within(rowOf("a1"));
    expect(row.queryByTestId("waiting-subagent-name")).toBeNull();
    expect(row.getByTestId("waiting-row-name").textContent).toBe("Review usage");
    expect(row.getByTestId("waiting-row-status").textContent).toBe("running");
  });

  it("Stop waiting runs the one command, once, leaving the asking to the daemon", async () => {
    setup({ wakes: [wake("sub-1", "timer")], shells: [shell("b1", "npm run dev")] });
    const stop = screen.getByTestId<HTMLButtonElement>("waiting-stop");
    fireEvent.click(stop);
    fireEvent.click(stop);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith("thread.stop-waiting", { id: "s" }, expect.objectContaining({ quiet: true }));
    await waitFor(() => {
      expect(stop.disabled).toBe(false);
    });
  });

  it("with only subagents left there is nothing to stop: the strip stays, without the button", () => {
    setup({ agents: [agent("a1")] });
    expect(screen.getByTestId("waiting-sentence").textContent).toBe("Waiting on 1 subagent");
    expect(screen.queryByTestId("waiting-stop")).toBeNull();
    expand();
    expect(rows().map((r) => r.dataset.kind)).toEqual(["subagent"]);
  });

  it("the words never say a child thread stops", () => {
    setup({ wakes: [wake("sub-1", "thread", { targetId: "c" })], others: [thread("c", { status: "busy", statusReason: "working" })] });
    expand();
    const stop = within(rowOf("sub-1")).getByTestId("waiting-remove");
    expect(stop.getAttribute("aria-label")).toBe("Stop listening for sub-1");
  });
});
