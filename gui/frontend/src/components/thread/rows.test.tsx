import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import { buildRows, buildTurns, decodeTimelineKey, timelineKey } from "@/lib/threadTimeline";
import { structOf, useThreadStore } from "@/stores/thread";
import { ThreadContext } from "./context";
import { TimelineRowView } from "./rows";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useThreadStore.setState({ logs: {}, expanded: {}, folds: {} });
});

const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };

function show(items: ThreadItemView[], opts: { working?: boolean; fold?: (turnKey: string) => boolean | undefined } = {}) {
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  useThreadStore.setState({ logs: { s: { seq: 1, byId, order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents: [] } } });
  const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: opts.fold ?? (() => undefined), working: opts.working ?? false });
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
    // The note is the last row; the copied turn above it folded under its header.
    expect(c.lastElementChild).toBe(note);
    expect(c.querySelector('[data-testid="thread-turn-header"]')?.getAttribute("data-folded")).toBe("true");
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

  it("is open while it runs, under a live header: spinner, Working, its steps and the time since its message", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(1 + 72_000);
    const c = show(turn, { working: true });
    expect(c.textContent).toContain("ls");
    const header = c.querySelector('[data-testid="thread-turn-header"]');
    expect(header?.hasAttribute("data-live")).toBe(true);
    // Under the user message, above the work.
    expect(header?.previousElementSibling?.getAttribute("data-testid")).toBe("thread-user");
    const working = header?.querySelector('[data-testid="thread-working"]');
    expect(working?.textContent).toBe("Working·1 step·1m 12s");
    expect(working?.querySelector(".shimmer")?.textContent).toBe("Working");
    expect(working?.querySelector("svg.animate-spin")).not.toBeNull();
    // Always open: nothing to click, and no copy while the answer may still grow.
    expect(header?.querySelector("button")).toBeNull();
    expect(c.querySelector('[aria-label="Copy answer"]')).toBeNull();
  });

  it("has no header while it runs with a request waiting (not working)", () => {
    const c = show(turn);
    expect(c.textContent).toContain("ls");
    expect(c.querySelector('[data-testid="thread-turn-header"]')).toBeNull();
  });

  it("folds under its header once it ends; the header reopens it (the user's choice)", () => {
    const c = show([...turn, end]);
    const header = c.querySelector('[data-testid="thread-turn-header"]');
    expect(header?.getAttribute("data-folded")).toBe("true");
    expect(header?.hasAttribute("data-live")).toBe(false);
    expect(header?.previousElementSibling?.getAttribute("data-testid")).toBe("thread-user");
    expect(c.textContent).not.toContain("ls");
    expect(c.querySelector('[data-testid="thread-text"]')?.textContent).toContain("done");
    const fold = header?.querySelector("button.fold");
    expect(fold?.getAttribute("aria-expanded")).toBe("false");
    expect(fold?.querySelector(".ico svg")).not.toBeNull();
    expect(fold?.textContent).toBe("Worked for 1.0s·1 step");
    // The copy moved to the answer.
    expect(header?.querySelector('[aria-label="Copy answer"]')).toBeNull();
    fireEvent.click(fold as HTMLButtonElement);
    expect(useThreadStore.getState().folds.s?.u).toBe(false);
  });

  it("unfolded, the header says so and the work shows below it", () => {
    const c = show([...turn, end], { fold: () => false });
    const header = c.querySelector('[data-testid="thread-turn-header"]');
    expect(header?.hasAttribute("data-folded")).toBe(false);
    expect(header?.querySelector("button.fold")?.getAttribute("aria-expanded")).toBe("true");
    expect(header?.querySelector("button.fold")?.getAttribute("aria-label")).toBe("Hide this turn's work");
    expect(header?.nextElementSibling?.textContent).toContain("ls");
  });

  it("the answer copies all of the turn's final text, joined by blank lines", async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window, "isSecureContext", { value: true, configurable: true });
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    const c = show([...turn, { ...base, id: "th", ordinal: 4, kind: "thinking", text: "" }, { ...base, id: "a2", ordinal: 5, kind: "text", text: "and more" }, { ...end, ordinal: 6 }]);
    const finals = c.querySelectorAll('[data-testid="thread-text"][data-final]');
    expect(finals).toHaveLength(2);
    // One copy action, on the answer's first row.
    expect(finals[0]?.querySelectorAll('[aria-label="Copy answer"]')).toHaveLength(1);
    expect(finals[1]?.querySelector('[aria-label="Copy answer"]')).toBeNull();
    fireEvent.click(finals[0]?.querySelector('[aria-label="Copy answer"]') as HTMLButtonElement);
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("done\n\nand more");
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

  it("is a smaller bubble inside the turn with “sent mid-turn · <time>” under it, and stays below the header when the turn folds", () => {
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
    // Folded: the work is gone, the steer and the answer stay; one header for the turn, above the steer.
    expect(c.textContent).not.toContain("sleep");
    expect(c.querySelector('[data-testid="thread-text"]')?.textContent).toContain("hi");
    expect(c.querySelectorAll('[data-testid="thread-turn-header"]')).toHaveLength(1);
    expect(c.querySelector('[data-testid="thread-turn-header"]')?.textContent).toContain("2 steps");
    expect(c.querySelector('[data-testid="thread-turn-header"]')?.nextElementSibling).toBe(steer);
  });

  it("a wake message mid-turn stays a wake note", () => {
    const wake = { title: "build", json: '{"status":"ok"}' };
    const c = show([...steered.slice(0, 2), { ...base, id: "w", ordinal: 3, kind: "user", text: "woken", attachments: [], composerText: "", wake }]);
    expect(c.querySelector('[data-testid="thread-wake-note"]')).not.toBeNull();
    expect(c.querySelector('[data-testid="thread-steer"]')).toBeNull();
  });

  it("an interrupted turn after a steer with no final text: one header that folds it, its first part red, nothing to copy", () => {
    const c = show([...steered, turnEndItem(interrupted)]);
    const header = c.querySelector('[data-testid="thread-turn-header"]');
    expect(c.querySelectorAll('[data-testid="thread-turn-header"]')).toHaveLength(1);
    expect(header?.textContent).toBe("Interrupted after 2.1s·2 steps·<$0.01");
    expect(header?.querySelector(".t-red")?.textContent).toBe("Interrupted after 2.1s");
    expect(header?.querySelector("button.fold")).not.toBeNull();
    expect(c.querySelector('[aria-label="Copy answer"]')).toBeNull();
    expect(c.querySelector('[data-testid="thread-steer"]')).not.toBeNull();
  });
});

describe("a finished turn with nothing to fold", () => {
  const hi: ThreadItemView = { ...base, id: "u", ordinal: 1, kind: "user", text: "hi", attachments: [], composerText: "" };

  it("shows its header as plain text: no chevron, no button, not focusable; the answer still copies", () => {
    const c = show([hi, { ...base, id: "a", ordinal: 2, kind: "text", text: "hello" }, turnEndItem()]);
    const header = c.querySelector('[data-testid="thread-turn-header"]');
    const line = header?.querySelector('[data-testid="thread-turn-header-line"]');
    expect(line?.textContent).toBe("Worked for 2.1s·<$0.01");
    expect(line?.querySelector("svg")).toBeNull();
    expect(header?.querySelector("button")).toBeNull();
    expect(header?.querySelector("[aria-expanded]")).toBeNull();
    expect(c.querySelector('[data-testid="thread-text"] [aria-label="Copy answer"]')).not.toBeNull();
  });

  it("an interrupted turn with no work and no answer keeps its wording and has nothing to copy", () => {
    const c = show([hi, turnEndItem(interrupted)]);
    const header = c.querySelector('[data-testid="thread-turn-header"]');
    expect(header?.textContent).toContain("Interrupted after 2.1s");
    expect(header?.querySelector("button")).toBeNull();
    expect(c.querySelector('[aria-label="Copy answer"]')).toBeNull();
  });

  it("a failed turn keeps its wording in red", () => {
    const c = show([hi, turnEndItem({ subtype: "error_max_turns", isError: true })]);
    const header = c.querySelector('[data-testid="thread-turn-header"]');
    expect(header?.querySelector(".t-red")?.textContent).toBe("Failed (error max turns) after 2.1s");
    expect(header?.querySelector("button")).toBeNull();
  });

  it("a turn still starting shows the live header with no steps", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(1 + 3_400);
    const c = show([hi], { working: true });
    expect(c.querySelector('[data-testid="thread-working"]')?.textContent).toBe("Working·3s");
  });
});
