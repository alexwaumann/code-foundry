import { describe, expect, it } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import { fixStalePrBadge, request } from "@/test/threadWorld";
import { caseSensitive, countLabel, findDoc, findMatches, matchIndex, matchOffsets, matchRows, rowOrder, startIndex, stepIndex, type FindMatch } from "./threadFind";

const base = { ordinal: 1, parentToolUseId: "", createdAtMs: null, updatedAtMs: null, streaming: false };
const item = (x: Record<string, unknown>) => ({ ...base, ...x }) as unknown as ThreadItemView;

describe("smart case", () => {
  it.each([
    ["head sha", false],
    ["Head", true],
    ["ünïcode", false],
    ["Éclair", true],
    ["123 _-", false],
  ])("%s: case-sensitive %s", (q, want) => {
    expect(caseSensitive(q)).toBe(want);
  });

  it("matches any case for a lower-case query, only its own case once it has a capital", () => {
    const text = "Fingerprint, fingerprint and FINGERPRINT";
    expect(matchOffsets(text, "fingerprint")).toHaveLength(3);
    expect(matchOffsets(text, "Fingerprint")).toEqual([{ start: 0, end: 11 }]);
    expect(matchOffsets(text, "FINGER")).toEqual([{ start: 29, end: 35 }]);
  });

  it("is a plain substring: no regex, no whole word, no overlaps", () => {
    expect(matchOffsets("a.b a+b", ".")).toEqual([{ start: 1, end: 2 }]);
    expect(matchOffsets("TestFingerprintChanges", "fingerprint")).toEqual([{ start: 4, end: 15 }]);
    expect(matchOffsets("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
    expect(matchOffsets("abc", "")).toEqual([]);
  });

  it("keeps offsets when a letter's lower case is longer (İ)", () => {
    const text = "İstanbul istanbul";
    expect(matchOffsets(text, "istanbul")).toEqual([{ start: 9, end: 17 }]);
    expect(text.slice(9, 17)).toBe("istanbul");
  });
});

describe("findDoc: what find searches", () => {
  it("a user message's bubble text, without its tags", () => {
    const [user] = fixStalePrBadge("idle").items;
    const doc = user ? findDoc(user) : null;
    expect(doc?.kind).toBe("user");
    expect(doc?.text).toBe("The PR badge in the sidebar stays green after a force-push, see  Look at  and fix it with . Keep the fingerprint check-count based in /tmp.");
  });

  it("Claude's text as rendered: no markdown marks, inline code without backticks", () => {
    const doc = findDoc(item({ id: "t", kind: "text", text: "The **head SHA** is in `query.graphql`." }));
    expect(doc).toEqual({ itemId: "t", kind: "text", text: "The head SHA is in query.graphql." });
  });

  it("an answered question's questions and answers, one line each", () => {
    const q = fixStalePrBadge("idle").items.find((it) => it.kind === "question");
    expect(q && findDoc(q)).toEqual({ itemId: q?.id, kind: "question", text: "How should the poller notice a force-push?\nHead SHA in the fingerprint" });
  });

  it("a skipped question's questions, with the dash its detail shows", () => {
    const inputJson = JSON.stringify({ questions: [{ question: "Which one?", header: "Pick", options: [] }] });
    expect(findDoc(item({ id: "q", kind: "question", request: request({ state: "denied", inputJson }) }))?.text).toBe("Which one?\n—");
  });

  it.each<[string, ThreadItemView]>([
    ["thinking", item({ id: "a", kind: "thinking", text: "fingerprint" })],
    ["a tool call", item({ id: "b", kind: "tool", name: "Bash", toolUseId: "t", inputJson: '{"command":"grep fingerprint"}', status: "done", output: "fingerprint", isError: false, resultJson: "" })],
    ["a permission request", item({ id: "c", kind: "permission", request: request({ toolName: "Bash", inputJson: '{"command":"fingerprint"}' }) })],
    ["a pending question", item({ id: "d", kind: "question", request: request({ inputJson: JSON.stringify({ questions: [{ question: "fingerprint?", options: [] }] }) }) })],
    ["a note", item({ id: "e", kind: "note", text: "Forked from fingerprint", createdBy: "" })],
    ["an error", item({ id: "f", kind: "error", text: "fingerprint" })],
    ["an API error text", item({ id: "g", kind: "text", text: "fingerprint", apiError: true })],
    ["a wake message", item({ id: "h", kind: "user", text: "fingerprint", attachments: [], composerText: "", wake: { lines: [] } })],
    ["a subagent's text", item({ id: "i", kind: "text", text: "fingerprint", parentToolUseId: "toolu_agent" })],
  ])("never %s", (_name, it) => {
    expect(findDoc(it)).toBeNull();
  });
});

describe("findMatches", () => {
  it("counts the thread's matches in order; the question's answer once", () => {
    const { items } = fixStalePrBadge("idle");
    const ms = findMatches(items, "head sha");
    expect(ms.map((m) => items.find((it) => it.id === m.itemId)?.kind)).toEqual(["text", "question", "text"]);
    // The summary row repeats the answer; only the detail's line counts.
    expect(ms.filter((m) => items.find((it) => it.id === m.itemId)?.kind === "question")).toHaveLength(1);
  });

  it("numbers each item's matches", () => {
    const items = [item({ id: "a", kind: "text", text: "x x" }), item({ id: "b", kind: "text", text: "x" })];
    expect(findMatches(items, "x").map((m) => [m.itemId, m.nth])).toEqual([
      ["a", 0],
      ["a", 1],
      ["b", 0],
    ]);
    expect(findMatches(items, "")).toEqual([]);
  });

  it("recounts a streaming answer as it grows", () => {
    const a = item({ id: "a", kind: "text", text: "one fin", streaming: true });
    expect(findMatches([a], "fin")).toHaveLength(1);
    const b = { ...a, text: "one fin, two fin" } as ThreadItemView;
    expect(findMatches([b], "fin")).toHaveLength(2);
  });
});

describe("navigation", () => {
  const ms: FindMatch[] = [
    { itemId: "a", nth: 0, start: 0, end: 1 },
    { itemId: "a", nth: 1, start: 2, end: 3 },
    { itemId: "c", nth: 0, start: 0, end: 1 },
  ];
  const order = new Map([
    ["a", 0],
    ["b", 1],
    ["c", 2],
  ]);

  it("steps forward and back, wrapping; from none to the first or the last", () => {
    expect(stepIndex(3, 0, 1)).toBe(1);
    expect(stepIndex(3, 2, 1)).toBe(0);
    expect(stepIndex(3, 0, -1)).toBe(2);
    expect(stepIndex(3, -1, 1)).toBe(0);
    expect(stepIndex(3, -1, -1)).toBe(2);
    expect(stepIndex(0, -1, 1)).toBe(-1);
  });

  it("finds a match by its key", () => {
    expect(matchIndex(ms, { itemId: "a", nth: 1 })).toBe(1);
    expect(matchIndex(ms, { itemId: "a", nth: 5 })).toBe(-1);
    expect(matchIndex(ms, null)).toBe(-1);
  });

  it("starts on the named item's first match, else the first at or after the list's top, else the last", () => {
    expect(startIndex(ms, order, { itemId: "c" })).toBe(2);
    expect(startIndex(ms, order, { itemId: "b", fromOrder: 0 })).toBe(0);
    expect(startIndex(ms, order, { fromOrder: 1 })).toBe(2);
    expect(startIndex(ms, order, { fromOrder: 3 })).toBe(2);
    expect(startIndex([], order, {})).toBe(-1);
  });

  it("labels the count", () => {
    expect(countLabel("x", 1, 3)).toBe("2 of 3");
    expect(countLabel("x", -1, 0)).toBe("0 of 0");
    expect(countLabel("", -1, 0)).toBe("");
  });
});

describe("the match map's rows", () => {
  it("a match's row is its item's, else the nearest row before it in the log", () => {
    const ms: FindMatch[] = [
      { itemId: "u", nth: 0, start: 0, end: 1 },
      { itemId: "q", nth: 0, start: 0, end: 1 },
      { itemId: "t2", nth: 0, start: 0, end: 1 },
    ];
    // q is folded away (no row): it shows at t1, the row before it.
    expect(matchRows(["u", "t1", "q", "t2"], ["u", "h:u", "t1", "t2"], ms)).toEqual([0, 2, 3]);
  });

  it("reads a row's item from its key", () => {
    const order = new Map([
      ["u", 0],
      ["x", 3],
    ]);
    expect(rowOrder("u", order)).toBe(0);
    expect(rowOrder("h:u", order)).toBe(0);
    expect(rowOrder("g:x", order)).toBe(3);
    expect(rowOrder("h:", order)).toBeUndefined();
  });
});
