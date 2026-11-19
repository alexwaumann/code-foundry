import { describe, expect, it } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import type { ThreadPendingView } from "@/api/thread";
import { ASK_HYSTERESIS, ASK_MIN_ROOM, askAsStrip, askTarget, contextLine, lastLine, MAX_REQUEST_LINES, nextNeedsThread, reconcileStep, requestLine, requestLines, stepBy, stepKey } from "./needsAsk";

/** The Needs-you inbox's pure parts (docs/notes/shell-17-needs-you.md). */

const base = { parentToolUseId: "", createdAtMs: 1, updatedAtMs: 1, streaming: false };
const text = (ordinal: number, t: string, o: Partial<{ parentToolUseId: string; apiError: true }> = {}): ThreadItemView => ({ ...base, id: `t-${String(ordinal)}`, ordinal, kind: "text", text: t, ...o });

describe("askTarget", () => {
  it.each([
    ["a command, whole", { command: "ls -la\n| wc -l" }, { kind: "command", text: "ls -la\n| wc -l" }],
    ["a file, relative to the checkout", { file_path: "/w/api/docs/a.md" }, { kind: "path", text: "docs/a.md" }],
    ["a notebook", { notebook_path: "/w/api/n.ipynb" }, { kind: "path", text: "n.ipynb" }],
    ["a page", { url: "https://example.com/x" }, { kind: "path", text: "https://example.com/x" }],
    ["anything else as JSON", { pattern: "*.go" }, { kind: "input", text: '{\n  "pattern": "*.go"\n}' }],
  ])("%s", (_, input, want) => {
    expect(askTarget({ inputJson: JSON.stringify(input) }, "/w/api")).toEqual(want);
  });

  it("nothing for no input", () => {
    expect(askTarget({ inputJson: "" }, "/w/api")).toBeNull();
  });
});

describe("the line of context", () => {
  it.each([
    ["the last line with words", "First.\n\nSecond line.\n", "Second line."],
    ["a list marker and emphasis stripped", "Plan:\n- run **the suite** with `make check`", "run the suite with make check"],
    ["a heading stripped", "## Next", "Next"],
    ["a fence or table row skipped", "Look:\n```\ncode\n```", "code"],
    ["nothing", "\n\n", ""],
  ])("%s", (_, t, want) => {
    expect(lastLine(t)).toBe(want);
  });

  it("is Claude's own last text before the ask: not a subagent's, not an API error, not after it", () => {
    const items = [text(1, "early"), text(3, "the one"), text(4, "a subagent's", { parentToolUseId: "tu-a" }), text(5, "API error", { apiError: true }), text(9, "after the ask")];
    expect(contextLine(items, 8)).toBe("the one");
    expect(contextLine(items, null)).toBe("after the ask");
    expect(contextLine([], 8)).toBe("");
    // A turn between threads that had nothing for the user (a lead passing a question up) is no context.
    expect(contextLine([...items, text(7, "[nothing new]")], 8)).toBe("the one");
  });
});

describe("cmd+shift+a's next thread", () => {
  it.each([
    ["the first with nothing to start from", null, "a"],
    ["the one after the popup's or the focused thread", "a", "b"],
    ["wrapping", "c", "a"],
    ["the first when the start is not in the list", "z", "a"],
  ])("%s", (_, from, want) => {
    expect(nextNeedsThread(["a", "b", "c"], from)).toBe(want);
  });

  it("none when nothing waits", () => {
    expect(nextNeedsThread([], "a")).toBeNull();
  });

  it.each([
    ["Ember first, as its row is above the list", null, "e"],
    ["from Ember, the list's first", "e", "a"],
    ["from the list's last, back to Ember", "b", "e"],
    ["from a thread not in the round, Ember", "z", "e"],
  ])("Ember waiting: %s", (_, from, want) => {
    expect(nextNeedsThread(["a", "b"], from, "e")).toBe(want);
  });

  it("Ember alone, and never twice in the round", () => {
    expect(nextNeedsThread([], null, "e")).toBe("e");
    expect(nextNeedsThread(["a", "e"], "a", "e")).toBe("e");
    expect(nextNeedsThread(["a", "e"], "e", "e")).toBe("a");
  });
});

describe("the ask as a strip in a short pane", () => {
  // A body of 500 with a 300 dock (a 150 card): 200 of conversation.
  const room = { body: 500, dock: 300, card: 150, strip: 33, showingStrip: false };

  it("keeps the full card while the conversation keeps ASK_MIN_ROOM", () => {
    expect(askAsStrip(room)).toBe(false);
    expect(askAsStrip({ ...room, body: 300 + ASK_MIN_ROOM })).toBe(false);
  });

  it("draws the strip once the conversation would keep less", () => {
    expect(askAsStrip({ ...room, body: 300 + ASK_MIN_ROOM - 1 })).toBe(true);
  });

  it("drawn as the strip, judges the room the full card would leave, and waits for ASK_HYSTERESIS more", () => {
    // The strip's dock: 300 - 150 + 33.
    const strip = { ...room, dock: 183, showingStrip: true };
    expect(askAsStrip({ ...strip, body: 300 + ASK_MIN_ROOM })).toBe(true);
    expect(askAsStrip({ ...strip, body: 300 + ASK_MIN_ROOM + ASK_HYSTERESIS - 1 })).toBe(true);
    expect(askAsStrip({ ...strip, body: 300 + ASK_MIN_ROOM + ASK_HYSTERESIS })).toBe(false);
  });

  it("changes nothing before the pane is laid out", () => {
    expect(askAsStrip({ ...room, body: 0 })).toBe(false);
    expect(askAsStrip({ ...room, body: 0, showingStrip: true })).toBe(true);
  });
});

/** Several open requests on one thread (docs/notes/needs-you-line-items.md). */
const pend = (n: number, o: Partial<ThreadPendingView> = {}): ThreadPendingView => ({ requestId: `r${String(n)}`, itemId: `i${String(n)}`, question: false, toolName: "Bash", summary: `Bash cmd ${String(n)}`, ...o });

describe("a Needs you row's lines", () => {
  it.each<[string, Partial<ThreadPendingView>, string, string]>([
    ["a command: the tool left out", { summary: "Bash git push --force-with-lease" }, "permission", "Permission: git push --force-with-lease"],
    ["another tool keeps its name", { toolName: "Write", summary: "Write notes.md" }, "permission", "Permission: Write notes.md"],
    ["a question", { question: true, toolName: "AskUserQuestion", summary: "Which base branch?" }, "question", "Question: Which base branch?"],
    ["a plan", { toolName: "ExitPlanMode", summary: "ExitPlanMode" }, "plan", "Plan: ready for review"],
    ["on one line", { summary: "Bash make \n  check" }, "permission", "Permission: make check"],
    ["no summary: the tool", { toolName: "WebFetch", summary: "" }, "permission", "Permission: WebFetch"],
  ])("%s", (_, o, kind, text) => {
    expect(requestLine(pend(1, o))).toEqual({ requestId: "r1", kind, text });
  });

  it("a worker's question passed up: its line says which thread it came from, even when it is the only request", () => {
    const passed = pend(1, { question: true, toolName: "AskUserQuestion", summary: "From Resize: Should the body drag too?", fromThreadId: "s-w" });
    expect(requestLine(passed)).toEqual({ requestId: "r1", kind: "question", text: "From Resize: Should the body drag too?" });
    expect(requestLines([passed])).toEqual({ lines: [requestLine(passed)], more: null });
    expect(requestLines([pend(2), passed]).lines.map((l) => l.text)).toEqual(["Permission: cmd 2", "From Resize: Should the body drag too?"]);
  });

  it("none for a thread with one open request or none: its row looks as it did", () => {
    expect(requestLines([])).toEqual({ lines: [], more: null });
    expect(requestLines([pend(1)])).toEqual({ lines: [], more: null });
  });

  it("one per request, oldest first, up to the cap", () => {
    const open = Array.from({ length: MAX_REQUEST_LINES }, (_, i) => pend(i + 1));
    expect(requestLines(open.slice(0, 2)).lines.map((l) => l.requestId)).toEqual(["r1", "r2"]);
    expect(requestLines(open)).toEqual({ lines: open.map(requestLine), more: null });
  });

  it("past the cap: the first three and \"+N more\", which names the first not listed", () => {
    const open = Array.from({ length: 7 }, (_, i) => pend(i + 1));
    const { lines, more } = requestLines(open);
    expect(lines.map((l) => l.requestId)).toEqual(["r1", "r2", "r3"]);
    expect(more).toEqual({ count: 4, requestId: "r4" });
    // Never more than the cap's lines, "+N more" included.
    expect(lines.length + 1).toBe(MAX_REQUEST_LINES);
  });
});

describe("the popup's stepper", () => {
  it.each<[string, string[], string[], string | null, string | null]>([
    ["the current one still open stays", ["a", "b", "c"], ["a", "b", "c"], "b", "b"],
    ["a new request arrives: the current one stays", ["a", "b"], ["a", "b", "c"], "a", "a"],
    ["answered (here or elsewhere): the next after it", ["a", "b", "c"], ["a", "c"], "b", "c"],
    ["answered with the next one gone too: the one after", ["a", "b", "c", "d"], ["a", "d"], "b", "d"],
    ["the last answered while earlier ones wait: the first of them", ["a", "b", "c"], ["a", "b"], "c", "a"],
    ["another one answered: the current one stays", ["a", "b", "c"], ["b", "c"], "b", "b"],
    ["every one answered: none", ["a"], [], "a", null],
    ["opened on none: the oldest", [], ["a", "b"], null, "a"],
    ["opened on one answered meanwhile: the oldest", [], ["a", "b"], "z", "a"],
  ])("%s", (_, prev, next, current, want) => {
    expect(reconcileStep(prev, next, current)).toBe(want);
  });

  it("steps one way or the other without wrapping", () => {
    expect(stepBy(["a", "b", "c"], "b", 1)).toBe("c");
    expect(stepBy(["a", "b", "c"], "b", -1)).toBe("a");
    expect(stepBy(["a", "b", "c"], "c", 1)).toBe("c");
    expect(stepBy(["a", "b", "c"], "a", -1)).toBe("a");
    expect(stepBy(["a", "b"], null, 1)).toBe("a");
    expect(stepBy([], null, 1)).toBeNull();
  });

  const key = (k: string, mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>> = {}) => ({ key: k, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...mods });

  it("the left and right arrows step, never with a modifier, never in text", () => {
    expect(stepKey(key("ArrowLeft"), false)).toBe(-1);
    expect(stepKey(key("ArrowRight"), false)).toBe(1);
    expect(stepKey(key("ArrowUp"), false)).toBe(0);
    expect(stepKey(key("1"), false)).toBe(0);
    expect(stepKey(key("ArrowRight", { metaKey: true }), false)).toBe(0);
    expect(stepKey(key("ArrowLeft", { shiftKey: true }), false)).toBe(0);
    expect(stepKey(key("ArrowLeft", { altKey: true }), false)).toBe(0);
    expect(stepKey(key("ArrowRight"), true)).toBe(0);
  });
});
