import { describe, expect, it } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import { ASK_HYSTERESIS, ASK_MIN_ROOM, askAsStrip, askTarget, contextLine, lastLine, nextNeedsThread } from "./needsAsk";

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
