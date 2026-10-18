import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentRunView } from "@/api/agents";
import type { ThreadItemView } from "@/api/thread";
import { buildRows, buildTurns, decodeTimelineKey, timelineKey } from "@/lib/threadTimeline";
import { structOf, useThreadStore } from "@/stores/thread";
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

const agentCall = (id: string, o: Partial<Extract<ThreadItemView, { kind: "tool" }>> = {}): ThreadItemView => ({
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
    expect(q(el, "thread-tool")?.getAttribute("aria-expanded")).toBe("false");
    expect(q(el, "thread-agent-failed")).toBeNull();
  });

  it("the spinner stays while the run runs even if the call's item says done", () => {
    const el = show([user, agentCall("t1", { status: "done" })], [run("a1", { toolUseId: "t1", background: true })]);
    expect(el.querySelector('[aria-label="Running"]')).not.toBeNull();
  });

  it("a running foreground run opens to show its work", () => {
    const el = show([user, agentCall("t1")], [run("a1", { toolUseId: "t1" })]);
    expect(q(el, "thread-agent-bg")).toBeNull();
    expect(q(el, "thread-tool")?.getAttribute("aria-expanded")).toBe("true");
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
