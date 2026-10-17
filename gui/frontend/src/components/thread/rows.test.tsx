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

describe("a user message's attachments the text does not refer to", () => {
  it("shows an image and a PDF as tiles, the PDF's pages from its staged name, never an <img> of the PDF", () => {
    const c = show([{ ...base, id: "u", ordinal: 1, kind: "user", text: "look", attachments: ["/att/a.png", "/att/0123-3p.pdf"], composerText: "" }]);
    const list = c.querySelector('[aria-label="Attached files"]');
    expect(list?.querySelectorAll('[data-testid="thread-attachment"]')).toHaveLength(2);
    const pdf = list?.querySelector('[data-kind="pdf"]');
    expect(pdf?.getAttribute("data-pages")).toBe("3");
    expect(pdf?.querySelector("img")).toBeNull();
  });
});

function turnEndItem(over: Partial<Extract<ThreadItemView, { kind: "turnEnd" }>> = {}): ThreadItemView {
  return {
    ...base,
    id: "e",
    ordinal: 99,
    kind: "turnEnd",
    subtype: "success",
    isError: false,
    interrupted: false,
    stopReason: "",
    terminalReason: "",
    durationMs: 2100,
    numTurns: 1,
    costUsd: 0.001,
    turnCostUsd: 0.001,
    model: "",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    errors: [],
    ...over,
  };
}

const interrupted = { subtype: "error_during_execution", isError: true, interrupted: true };

describe("a message sent mid-turn (a steer)", () => {
  const at = new Date(2026, 9, 17, 14, 12).getTime();
  const steered: ThreadItemView[] = [
    { ...base, id: "u", ordinal: 1, kind: "user", text: "run it", attachments: [], composerText: "" },
    { ...base, id: "t1", ordinal: 2, kind: "tool", toolUseId: "t1", name: "Bash", inputJson: '{"command":"sleep 1"}', status: "done", output: "", isError: false, resultJson: "" },
    { ...base, id: "s", ordinal: 3, kind: "user", text: "also say hi", attachments: [], composerText: "", createdAtMs: at },
    { ...base, id: "t2", ordinal: 4, kind: "tool", toolUseId: "t2", name: "Bash", inputJson: '{"command":"sleep 2"}', status: "done", output: "", isError: false, resultJson: "" },
  ];

  it("is a smaller bubble inside the turn with “sent mid-turn · <time>” under it, and stays when the turn folds", () => {
    const c = show([...steered, { ...base, id: "a", ordinal: 5, kind: "text", text: "hi" }, turnEndItem()]);
    expect(c.querySelectorAll('[data-testid="thread-user"]')).toHaveLength(1);
    const steer = c.querySelector('[data-testid="thread-steer"]');
    const bubble = steer?.querySelector(".bubble");
    expect(bubble?.textContent).toBe("also say hi");
    expect(bubble?.className).toContain("text-body-sm");
    expect(bubble?.className).toContain("rounded-lg");
    const caption = steer?.querySelector('[data-testid="thread-steer-caption"]');
    expect(caption?.className).toContain("text-caption");
    expect(caption?.textContent).toMatch(/^sent mid-turn · \d\d:12/);
    expect(caption?.querySelector("svg")).not.toBeNull();
    // Folded: the work is gone, the steer and the answer stay; one footer for the turn.
    expect(c.textContent).not.toContain("sleep");
    expect(c.querySelector('[data-testid="thread-text"]')?.textContent).toContain("hi");
    expect(c.querySelectorAll('[data-testid="thread-footer"]')).toHaveLength(1);
    expect(c.querySelector('[data-testid="thread-footer"]')?.textContent).toContain("2 steps");
  });

  it("a wake message mid-turn stays a wake note", () => {
    const wake = { title: "build", json: '{"status":"ok"}' };
    const c = show([...steered.slice(0, 2), { ...base, id: "w", ordinal: 3, kind: "user", text: "woken", attachments: [], composerText: "", wake }]);
    expect(c.querySelector('[data-testid="thread-wake-note"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="thread-steer"]')).toBeNull();
  });

  it("an interrupted turn after a steer with no final text: one footer that folds it, no copy button", () => {
    const c = show([...steered, turnEndItem(interrupted)]);
    const footer = c.querySelector('[data-testid="thread-footer"]');
    expect(c.querySelectorAll('[data-testid="thread-footer"]')).toHaveLength(1);
    expect(footer?.textContent).toContain("Interrupted after 2.1s");
    expect(footer?.querySelector("button.fold")).not.toBeNull();
    expect(footer?.querySelector('[aria-label="Copy answer"]')).toBeNull();
    expect(c.querySelector('[data-testid="thread-steer"]')).not.toBeNull();
  });
});

describe("a finished turn with nothing to fold", () => {
  const hi: ThreadItemView = { ...base, id: "u", ordinal: 1, kind: "user", text: "hi", attachments: [], composerText: "" };

  it("shows its footer as plain text: no chevron, no button, not focusable; the answer still copies", () => {
    const c = show([hi, { ...base, id: "a", ordinal: 2, kind: "text", text: "hello" }, turnEndItem()]);
    const footer = c.querySelector('[data-testid="thread-footer"]');
    const line = footer?.querySelector('[data-testid="thread-footer-line"]');
    expect(line?.textContent).toBe("Worked for 2.1s·<$0.01");
    expect(line?.querySelector("svg")).toBeNull();
    expect(footer?.querySelector("button.fold")).toBeNull();
    expect(footer?.querySelector("[aria-expanded]")).toBeNull();
    expect(footer?.querySelectorAll("button")).toHaveLength(1);
    expect(footer?.querySelector('[aria-label="Copy answer"]')).not.toBeNull();
  });

  it("an interrupted turn with no work and no answer keeps its wording and has no copy button", () => {
    const c = show([hi, turnEndItem(interrupted)]);
    const footer = c.querySelector('[data-testid="thread-footer"]');
    expect(footer?.textContent).toContain("Interrupted after 2.1s");
    expect(footer?.querySelector("button")).toBeNull();
  });

  it("a failed turn keeps its wording in red", () => {
    const c = show([hi, turnEndItem({ subtype: "error_max_turns", isError: true })]);
    const footer = c.querySelector('[data-testid="thread-footer"]');
    expect(footer?.querySelector(".t-red")?.textContent).toBe("Failed (error max turns) after 2.1s");
    expect(footer?.querySelector("button")).toBeNull();
  });
});
