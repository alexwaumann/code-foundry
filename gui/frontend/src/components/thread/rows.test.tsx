import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import { buildRows, buildTurns, decodeTimelineKey, timelineKey } from "@/lib/threadTimeline";
import { structOf, useThreadStore } from "@/stores/thread";
import { ThreadContext } from "./context";
import { TimelineRowView } from "./rows";

afterEach(() => {
  cleanup();
  useThreadStore.setState({ logs: {}, expanded: {}, folds: {} });
});

const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };

function show(items: ThreadItemView[]) {
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  useThreadStore.setState({ logs: { s: { seq: 1, byId, order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents: [] } } });
  const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: () => undefined, working: false });
  return render(
    <ThreadContext.Provider value={{ threadId: "s", cwd: "/w" }}>
      {rows.map((r) => (
        <TimelineRowView key={r.key} row={r} />
      ))}
    </ThreadContext.Provider>,
  ).container;
}

function editWaiting(name: string, input: object): ThreadItemView[] {
  return [
    { ...base, id: "u", ordinal: 1, kind: "user", text: "go", attachments: [], composerText: "" },
    { ...base, id: "tu", ordinal: 2, kind: "tool", toolUseId: "tu", name, inputJson: JSON.stringify(input), status: "running", output: "", isError: false, resultJson: "" },
    {
      ...base,
      id: "perm-r",
      ordinal: 3,
      kind: "permission",
      request: {
        requestId: "r",
        toolName: name,
        displayName: name,
        title: "",
        description: "",
        toolUseId: "tu",
        agentId: "",
        blockedPath: "",
        decisionReason: "",
        inputJson: JSON.stringify(input),
        suggestionsJson: "",
        state: "pending",
        decision: "",
        message: "",
        answers: {},
      },
    },
  ];
}

describe("a tool waiting for permission", () => {
  it("an Edit shows its diff, so the user sees what they allow", () => {
    const c = show(editWaiting("Edit", { file_path: "/w/a.go", old_string: "x := 1", new_string: "x := 2" }));
    expect(c.querySelector('[data-waiting="true"]')?.textContent).toContain("waiting for you");
    expect(c.querySelector('[data-testid="thread-diff"]')?.textContent).toContain("x := 2");
  });

  it("a Bash call does not expand (the docked prompt shows the command)", () => {
    const c = show(editWaiting("Bash", { command: "git push" }));
    expect(c.querySelector('[data-waiting="true"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="thread-bash"]')).toBeNull();
  });
});

describe("a system note", () => {
  it("is one centered separator line after the copied history, outside any turn's fold", () => {
    const c = show([
      { ...base, id: "u", ordinal: 1, kind: "user", text: "hi", attachments: [], composerText: "" },
      { ...base, id: "t", ordinal: 2, kind: "tool", toolUseId: "t", name: "Bash", inputJson: '{"command":"ls"}', status: "done", output: "", isError: false, resultJson: "" },
      { ...base, id: "a", ordinal: 3, kind: "text", text: "hello" },
      {
        ...base,
        id: "e",
        ordinal: 4,
        kind: "turnEnd",
        subtype: "success",
        isError: false,
        interrupted: false,
        stopReason: "",
        terminalReason: "",
        durationMs: 1000,
        numTurns: 1,
        costUsd: 0,
        turnCostUsd: null,
        model: "",
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        errors: [],
      },
      { ...base, id: "note-fork-p", ordinal: 5, kind: "note", text: "Forked from fix-badge" },
    ]);
    const note = c.querySelector('[data-testid="thread-note"]');
    expect(note?.getAttribute("role")).toBe("separator");
    expect(note?.textContent).toBe("Forked from fix-badge");
    // The note is the last row; the copied turn above it folded under its footer.
    expect(c.lastElementChild).toBe(note);
    expect(c.querySelector('[data-testid="thread-footer"]')?.getAttribute("data-folded")).toBe("true");
  });
});

describe("the latest turn", () => {
  const turn: ThreadItemView[] = [
    { ...base, id: "u", ordinal: 1, kind: "user", text: "hi", attachments: [], composerText: "" },
    { ...base, id: "t", ordinal: 2, kind: "tool", toolUseId: "t", name: "Bash", inputJson: '{"command":"ls"}', status: "done", output: "", isError: false, resultJson: "" },
    { ...base, id: "a", ordinal: 3, kind: "text", text: "done" },
  ];
  const end: ThreadItemView = {
    ...base,
    id: "e",
    ordinal: 4,
    kind: "turnEnd",
    subtype: "success",
    isError: false,
    interrupted: false,
    stopReason: "",
    terminalReason: "",
    durationMs: 1000,
    numTurns: 1,
    costUsd: 0,
    turnCostUsd: null,
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    errors: [],
  };

  it("is open while it runs", () => {
    const c = show(turn);
    expect(c.textContent).toContain("ls");
    expect(c.querySelector('[data-testid="thread-footer"]')).toBeNull();
  });

  it("folds under its footer once it ends; the footer reopens it (the user's choice)", () => {
    const c = show([...turn, end]);
    const footer = c.querySelector('[data-testid="thread-footer"]');
    expect(footer?.getAttribute("data-folded")).toBe("true");
    expect(c.textContent).not.toContain("ls");
    expect(c.querySelector('[data-testid="thread-text"]')?.textContent).toContain("done");
    fireEvent.click(footer?.querySelector("button.fold") as HTMLButtonElement);
    expect(useThreadStore.getState().folds.s?.u).toBe(false);
  });
});
