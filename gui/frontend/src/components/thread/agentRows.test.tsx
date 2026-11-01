import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { ThreadItemView } from "@/api/thread";
import { buildRows, buildTurns, decodeTimelineKey, timelineKey } from "@/lib/threadTimeline";
import { setRowExpanded, structOf, useThreadStore } from "@/stores/thread";
import { ThreadContext } from "./context";
import { TimelineRowView } from "./rows";

/** Agent rows and the daemon's agent notes (docs/notes/agents-2-gui.md). */

afterEach(() => {
  cleanup();
  useThreadStore.setState({ logs: {}, expanded: {}, folds: {} });
});

const NOW = Date.now();
const base = { parentToolUseId: "", createdAtMs: NOW, updatedAtMs: NOW, streaming: false };

function run(id: string, o: Partial<AgentRunView> = {}): AgentRunView {
  return {
    id,
    toolUseId: "",
    parentId: "",
    description: "PR 1",
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
    startedAtMs: NOW - 252_000,
    resumedAtMs: null,
    endedAtMs: null,
    noteItemId: "",
    ...o,
  };
}

const agentCall = (id: string, o: Partial<Extract<ThreadItemView, { kind: "tool" }>> = {}): Extract<ThreadItemView, { kind: "tool" }> => ({
  ...base,
  id,
  ordinal: 2,
  kind: "tool",
  toolUseId: id,
  name: "Agent",
  inputJson: JSON.stringify({ description: "PR 1", subagent_type: "general-purpose" }),
  status: "running",
  output: "",
  isError: false,
  resultJson: "",
  ...o,
});

function show(items: ThreadItemView[], agents: AgentRunView[]) {
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  useThreadStore.setState({ logs: { s: { seq: 1, byId, order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents } } });
  const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: () => undefined, working: false });
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

const user: ThreadItemView = { ...base, id: "u", ordinal: 1, kind: "user", text: "go", attachments: [], composerText: "" };
const q = (el: HTMLElement, id: string) => el.querySelector(`[data-testid="${id}"]`);

describe("Agent rows", () => {
  it("a running background run: background chip, activity after a ·, live elapsed, spinner; stays a line", () => {
    const el = show([user, agentCall("t1")], [run("a1", { toolUseId: "t1", background: true, activity: "Running go test ./..." })]);
    expect(q(el, "thread-agent-bg")?.textContent).toBe("background");
    expect(q(el, "thread-agent-bg")?.className).toBe("chip bg");
    expect(q(el, "thread-agent-activity")?.textContent).toBe("Running go test ./...");
    expect(q(el, "thread-agent-activity")?.className).toBe("act");
    expect(q(el, "thread-agent-elapsed")?.textContent).toMatch(/^4m 1\ds$/);
    expect(el.querySelector('[aria-label="Running"]')).not.toBeNull();
    // One line: nothing to open while it runs.
    expect(q(el, "thread-tool")?.tagName).toBe("DIV");
    expect(q(el, "thread-tool")?.hasAttribute("aria-expanded")).toBe(false);
    expect(q(el, "thread-agent-failed")).toBeNull();
  });

  it("the meta's order: chip, activity, elapsed, spinner (the activity fills the line between)", () => {
    const el = show([user, agentCall("t1")], [run("a1", { toolUseId: "t1", background: true, activity: "Reading internal/store/thread/agents.go" })]);
    const meta = q(el, "thread-tool")?.querySelector(".meta");
    expect([...(meta?.children ?? [])].map((c) => c.getAttribute("data-testid") ?? c.getAttribute("aria-label"))).toEqual(["thread-agent-bg", "thread-agent-activity", "thread-agent-elapsed", "Running"]);
  });

  it.each([
    { name: "a foreground run", o: {} },
    { name: "a background run", o: { background: true } },
    { name: "a nested run (spawned by another run)", o: { spawnDepth: 2, parentId: "a0" } },
  ])("$name shows its activity while it runs", ({ o }) => {
    const el = show([user, agentCall("t1")], [run("a1", { toolUseId: "t1", activity: "Running go vet", ...o })]);
    expect(q(el, "thread-agent-activity")?.textContent).toBe("Running go vet");
  });

  it("the spinner stays while the run runs even if the call's item says done", () => {
    const el = show([user, agentCall("t1", { status: "done" })], [run("a1", { toolUseId: "t1", background: true })]);
    expect(el.querySelector('[aria-label="Running"]')).not.toBeNull();
  });

  // The run's own items (parent_tool_use_id = the call): they belong to the subagent view,
  // never under the row in the thread.
  const work: ThreadItemView[] = [
    { ...agentCall("b1"), ordinal: 3, parentToolUseId: "t1", name: "Bash", inputJson: JSON.stringify({ command: "go vet ./..." }) },
    { ...base, id: "x1", ordinal: 4, parentToolUseId: "t1", kind: "text", text: "Vet is clean." },
  ];
  const REPORT = JSON.stringify({ content: [{ type: "text", text: "All checks pass." }] });

  it.each([
    { name: "a running foreground run", call: {}, r: {}, opens: false },
    { name: "a running background run", call: {}, r: { background: true }, opens: false },
    { name: "a running nested run", call: {}, r: { spawnDepth: 2, parentId: "a0" }, opens: false },
    { name: "a call done while its run runs on", call: { status: "done" as const, resultJson: REPORT }, r: { background: true }, opens: false },
    { name: "a done run with a report", call: { status: "done" as const, resultJson: REPORT }, r: { status: "done" as const, endedAtMs: NOW }, opens: true },
    { name: "a done run without one", call: { status: "done" as const }, r: { status: "done" as const, endedAtMs: NOW }, opens: false },
    { name: "an older daemon's running call", call: {}, r: null, opens: false },
    { name: "an older daemon's done call", call: { status: "done" as const, resultJson: REPORT }, r: null, opens: true },
  ])("$name: one line, never open by itself, never its nested rows (opens: $opens)", ({ call, r, opens }) => {
    const el = show([user, agentCall("t1", call), ...work], r ? [run("a1", { toolUseId: "t1", ...r })] : []);
    const row = q(el, "thread-tool") as HTMLElement;
    expect(row.tagName).toBe(opens ? "BUTTON" : "DIV");
    expect(row.querySelector(".chev") !== null).toBe(opens);
    if (opens) {
      expect(row.getAttribute("aria-expanded")).toBe("false");
      fireEvent.click(row);
      expect(row.getAttribute("aria-expanded")).toBe("true");
      expect(q(el, "thread-agent-report")?.textContent).toBe("All checks pass.");
    }
    if (!opens) expect(q(el, "thread-agent-report")).toBeNull();
    // Only the Agent call itself: none of the run's rows, open or not.
    expect([...el.querySelectorAll("[data-tool]")].map((e) => e.getAttribute("data-tool"))).toEqual(["Agent"]);
    expect(el.textContent).not.toContain("Vet is clean.");
  });

  it("a row the reader had opened shows no nested rows while its run runs", () => {
    setRowExpanded("s", "t1", true);
    const el = show([user, agentCall("t1"), ...work], [run("a1", { toolUseId: "t1" })]);
    expect(q(el, "thread-tool")?.tagName).toBe("DIV");
    expect(el.querySelectorAll("[data-tool]")).toHaveLength(1);
    expect(q(el, "thread-agent-report")).toBeNull();
  });

  it("a failed background run: background and failed chips, its duration, no spinner", () => {
    const el = show(
      [user, agentCall("t1", { status: "error", isError: true, output: "Stopped" })],
      [run("a1", { toolUseId: "t1", background: true, status: "failed", error: "Stopped", durationMs: 63_000, endedAtMs: NOW })],
    );
    expect(q(el, "thread-agent-bg")?.textContent).toBe("background");
    expect(q(el, "thread-agent-failed")?.textContent).toBe("failed");
    expect(q(el, "thread-agent-failed")?.className).toBe("chip fail");
    expect(el.querySelector('[aria-label="Running"]')).toBeNull();
    expect(q(el, "thread-tool")?.textContent).toContain("1m 03s");
    // The call's own "error" chip gives way to "failed".
    expect(el.querySelectorAll(".chip.fail")).toHaveLength(1);
  });

  it("a done run keeps the call's own meta", () => {
    const el = show(
      [user, agentCall("t1", { status: "done", resultJson: JSON.stringify({ totalToolUseCount: 4, totalDurationMs: 41_000 }) })],
      [run("a1", { toolUseId: "t1", status: "done", durationMs: 41_000, endedAtMs: NOW })],
    );
    expect(q(el, "thread-tool")?.textContent).toContain("4 tools · 41s");
    expect(q(el, "thread-agent-activity")).toBeNull();
  });

  it("without a run (an older daemon) the row is as before", () => {
    const el = show([user, agentCall("t1")], []);
    expect(q(el, "thread-agent-bg")).toBeNull();
    expect(el.querySelector('[aria-label="Running"]')).not.toBeNull();
  });
});

describe("agent notes", () => {
  const note = (id: string, text: string): ThreadItemView => ({ ...base, id, ordinal: 9, kind: "note", text, createdBy: "", createdAtMs: NOW - 3 * 60_000 });

  it("a finished run: green check, the name, the report, its age", () => {
    const el = show([note("n1", "Agent finished · PR 1 · Added tests; make check is green.")], []);
    const row = q(el, "thread-agent-note") as HTMLElement;
    expect(row.getAttribute("data-failed")).toBeNull();
    expect(row.querySelector("svg")?.getAttribute("aria-label")).toBe("Finished");
    expect(row.querySelector("svg")?.getAttribute("class")).toContain("t-emerald");
    expect(q(row, "thread-agent-note-name")?.textContent).toBe("PR 1");
    expect(q(row, "thread-agent-note-summary")?.textContent).toBe("Added tests; make check is green.");
    expect(row.textContent).toBe("Agent finished·PR 1Added tests; make check is green.3 min ago");
    expect(q(el, "thread-note")).toBeNull();
  });

  it("a failed run: red cross", () => {
    const el = show([note("n1", "Agent failed · Shot · Stopped: exit 1")], []);
    const row = q(el, "thread-agent-note") as HTMLElement;
    expect(row.getAttribute("data-failed")).toBe("true");
    expect(row.querySelector("svg")?.getAttribute("class")).toContain("t-red");
    expect(row.textContent).toContain("Agent failed");
  });

  it("the linked run's name splits a name with a · in it", () => {
    const el = show([note("n1", "Agent finished · A · B · done")], [run("a1", { description: "A · B", status: "done", noteItemId: "n1" })]);
    expect(q(el, "thread-agent-note-name")?.textContent).toBe("A · B");
    expect(q(el, "thread-agent-note-summary")?.textContent).toBe("done");
  });

  it("other notes stay the centered divider", () => {
    const el = show([note("n1", "Forked from Fix the badge")], []);
    expect(q(el, "thread-agent-note")).toBeNull();
    expect(q(el, "thread-note")?.textContent).toBe("Forked from Fix the badge");
  });
});

/**
 * The mock's "agents" s-r1 (mock/agents.ts) as its Watch brings it, then a run ending over the
 * stream: the folded finished turn with its background Agent calls and the failed run's note.
 */
describe("background runs in a finished turn", () => {
  const REPORT = "Added task frame handling to the thread store with 14 table tests; make check is green.";
  const bg = (id: string, description: string, o: Partial<Extract<ThreadItemView, { kind: "tool" }>> = {}) =>
    agentCall(id, { inputJson: JSON.stringify({ description, subagent_type: "general-purpose", run_in_background: true }), ...o });
  const turn: ThreadItemView[] = [
    { ...user, text: "Build the agents panel" },
    bg("t1", "PR 1: daemon task frames"),
    { ...bg("t2", "PR 2: Agents surface in the panel"), ordinal: 3 },
    { ...bg("t3", "Screenshot the panel in Wails", { status: "error", isError: true, output: "Stopped: process exited with code 1" }), ordinal: 4 },
    { ...base, id: "a", ordinal: 5, kind: "text", text: "Both PRs are building in the background." },
    { ...base, id: "e", ordinal: 6, kind: "turnEnd", subtype: "success", isError: false, interrupted: false, stopReason: "end_turn", terminalReason: "", durationMs: 48_000, numTurns: 4, costUsd: 0.12, turnCostUsd: 0.12, model: "claude-opus-4-8", inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, errors: [] },
    { ...base, id: "n3", ordinal: 7, kind: "note", text: "Agent failed · Screenshot the panel in Wails · Stopped: process exited with code 1", createdBy: "", createdAtMs: NOW - 3 * 60_000 },
  ];
  const runs = [
    run("a1", { toolUseId: "t1", description: "PR 1: daemon task frames", background: true, activity: "Running go test ./internal/store/..." }),
    run("a2", { toolUseId: "t2", description: "PR 2: Agents surface in the panel", background: true }),
    run("a3", { toolUseId: "t3", description: "Screenshot the panel in Wails", background: true, status: "failed", error: "Stopped: process exited with code 1", endedAtMs: NOW - 3 * 60_000, noteItemId: "n3" }),
  ];

  function Rows({ items }: { items: ThreadItemView[] }) {
    const folds = useThreadStore((s) => s.folds.s);
    const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: (k) => folds?.[k], working: false });
    return (
      <div className="cf-thread">
        <ThreadContext.Provider value={{ threadId: "s", cwd: "/w" }}>
          {rows.map((r) => (
            <TimelineRowView key={r.key} row={r} />
          ))}
        </ThreadContext.Provider>
      </div>
    );
  }
  const put = (items: ThreadItemView[], agents: AgentRunView[]) => {
    useThreadStore.setState({ logs: { s: { seq: 1, byId: Object.fromEntries(items.map((it) => [it.id, it])), order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents } } });
  };
  const call = (el: HTMLElement, name: string) => [...el.querySelectorAll<HTMLElement>('[data-tool="Agent"]')].find((e) => e.textContent.includes(name)) as HTMLElement;

  it("folded, the failed run's note shows; unfolded, the runs' chips; one ending turns its row done, opening to its report only, and a finished note follows", () => {
    put(turn, runs);
    const view = render(<Rows items={turn} />);
    const el = view.container;
    const notes = () => [...el.querySelectorAll<HTMLElement>('[data-testid="thread-agent-note"]')];
    expect(notes()).toHaveLength(1);
    expect(notes()[0]?.getAttribute("data-failed")).toBe("true");
    expect(q(notes()[0] as HTMLElement, "thread-agent-note-name")?.textContent).toBe("Screenshot the panel in Wails");
    expect(q(notes()[0] as HTMLElement, "thread-agent-note-summary")?.textContent).toBe("Stopped: process exited with code 1");
    expect(notes()[0]?.textContent).toContain("Agent failed");
    expect(q(el, "thread-note")).toBeNull();

    fireEvent.click(el.querySelector('[data-testid="thread-turn-header"] button.fold') as HTMLElement);
    expect([...el.querySelectorAll('[data-tool="Agent"]')].filter((a) => q(a as HTMLElement, "thread-agent-bg"))).toHaveLength(3);
    const pr1 = () => call(el, "PR 1: daemon task frames");
    expect(pr1().getAttribute("data-status")).toBe("running");
    expect(q(pr1(), "thread-agent-activity")?.textContent).toBe("Running go test ./internal/store/...");
    const shot = call(el, "Screenshot the panel in Wails");
    expect(q(shot, "thread-agent-failed")?.textContent).toBe("failed");
    expect(q(shot, "thread-agent-bg")?.textContent).toBe("background");

    // PR 1 ends (the daemon's call update, run and note).
    const ended = [
      ...turn.map((it) => (it.id === "t1" && it.kind === "tool" ? { ...it, status: "done" as const, output: REPORT } : it)),
      { ...base, id: "n1", ordinal: 8, kind: "note" as const, text: `Agent finished · PR 1: daemon task frames · ${REPORT}`, createdBy: "" },
    ];
    act(() => {
      put(ended, runs.map((r) => (r.id === "a1" ? { ...r, status: "done" as const, summary: REPORT, endedAtMs: NOW, noteItemId: "n1" } : r)));
    });
    view.rerender(<Rows items={ended} />);
    expect(pr1().getAttribute("data-status")).toBe("done");
    expect(q(pr1(), "thread-agent-activity")).toBeNull();
    const row = q(pr1(), "thread-tool") as HTMLElement;
    expect(row.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(row);
    expect(q(pr1(), "thread-agent-report")?.textContent).toBe(REPORT);
    expect(pr1().querySelectorAll("[data-tool]")).toHaveLength(0);
    expect(notes()).toHaveLength(2);
    const done = notes()[1] as HTMLElement;
    expect(done.getAttribute("data-failed")).toBeNull();
    expect(q(done, "thread-agent-note-name")?.textContent).toBe("PR 1: daemon task frames");
    expect(q(done, "thread-agent-note-summary")?.textContent).toBe(REPORT);
    expect(done.textContent).toContain("just now");
  });

  it("a background shell's call runs while its item says so and is done once the daemon ends it, in a finished turn", () => {
    const shell = (id: string, name: string, input: object, status: "running" | "done") => ({ ...base, id, ordinal: 2, kind: "tool" as const, toolUseId: id, name, inputJson: JSON.stringify(input), status, output: "", isError: false, resultJson: "" });
    const items = (b: "running" | "done", m: "running" | "done"): ThreadItemView[] => [
      user,
      shell("b", "Bash", { command: "make gui-e2e", run_in_background: true }, b),
      { ...shell("m", "Monitor", { command: "tail -f log" }, m), ordinal: 3 },
      { ...turn[5], ordinal: 4 } as ThreadItemView,
    ];
    put(items("running", "running"), []);
    useThreadStore.setState({ folds: { s: { u: false } } });
    const view = render(<Rows items={items("running", "running")} />);
    const status = (name: string) => view.container.querySelector(`[data-tool="${name}"]`)?.getAttribute("data-status");
    expect([status("Bash"), status("Monitor")]).toEqual(["running", "running"]);
    act(() => {
      put(items("done", "running"), []);
    });
    view.rerender(<Rows items={items("done", "running")} />);
    expect([status("Bash"), status("Monitor")]).toEqual(["done", "running"]);
  });
});
