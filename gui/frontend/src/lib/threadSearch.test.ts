import { describe, expect, it } from "vitest";
import type { SearchGroupView, SearchHitView, SearchResultView } from "@/api/threadSearch";
import { currentMatchIndex, dayLabel, fitSnippet, firstSelectable, handoffMatches, handoffQuery, keepSelection, messagesLabel, moveSelection, queryMatches, searchRows, searchTerms, textRuns } from "./threadSearch";

describe("searchTerms", () => {
  it.each([
    ["one", ["one"]],
    ["  two   words ", ["two", "words"]],
    ['"a  phrase" word', ["a phrase", "word"]],
    ['open "unclosed  quote', ["open", "unclosed quote"]],
    ['mid"dle', ["mid", "dle"]],
    ["ctl\u0007char", ["ctlchar"]],
    ['""', []],
  ])("%j → %j", (q, want) => {
    expect(searchTerms(q)).toEqual(want);
  });
});

describe("handoffQuery", () => {
  it("hands one term or phrase over as it is, else the longest term (the first of equals, emoji counted once)", () => {
    expect(handoffQuery("fingerprint")).toBe("fingerprint");
    expect(handoffQuery('"stale badge"')).toBe("stale badge");
    expect(handoffQuery("go badge fix")).toBe("badge");
    expect(handoffQuery("abc 🐛🐛")).toBe("abc");
    expect(handoffQuery("   ")).toBe("");
  });
  it("hands over only a term with a capital of its own when the query is case-sensitive", () => {
    // "fingerprint" is longer, but the bar would search it without case.
    expect(handoffQuery("HeadOid fingerprint")).toBe("HeadOid");
    expect(handoffQuery("Go badge Fix")).toBe("Fix");
    expect(handoffQuery("headoid fingerprint")).toBe("fingerprint");
  });
});

describe("handoffMatches (what the find bar counts in a message)", () => {
  it("counts only the handed-over term, with the bar's smart case over it", () => {
    const t = "Fingerprint and fingerprint, the stale badge";
    expect(handoffMatches(t, "stale fingerprint").map((m) => t.slice(m.start, m.end))).toEqual(["Fingerprint", "fingerprint"]);
    expect(handoffMatches(t, "Fingerprint").map((m) => t.slice(m.start, m.end))).toEqual(["Fingerprint"]);
    expect(handoffMatches(t, "   ")).toEqual([]);
  });
});

describe("queryMatches (the preview matches the whole message again)", () => {
  const text = "The Fingerprint moved; the fingerprint now has the head.";
  it("is case-insensitive without a capital letter, every term, in order", () => {
    expect(queryMatches(text, "fingerprint head").map((m) => text.slice(m.start, m.end))).toEqual(["Fingerprint", "fingerprint", "head"]);
  });
  it("makes every term exact once one has a capital letter (smart case over the query)", () => {
    expect(queryMatches(text, "Fingerprint the").map((m) => text.slice(m.start, m.end))).toEqual(["Fingerprint", "the", "the"]);
  });
  it("merges overlapping matches of two terms", () => {
    expect(queryMatches("abcdef", "abcd cdef")).toEqual([{ start: 0, end: 6 }]);
  });
  it("counts UTF-16 offsets in text with emoji", () => {
    const t = "🔥 fix 🐛 fix";
    expect(queryMatches(t, "fix").map((m) => t.slice(m.start, m.end))).toEqual(["fix", "fix"]);
  });
  it("picks as current the first match of the handed-over term", () => {
    const t = "a badge and a stale badge";
    const ms = queryMatches(t, "stale badge");
    expect(ms.map((m) => t.slice(m.start, m.end))).toEqual(["badge", "stale", "badge"]);
    // "stale" is longer: the bar takes "stale", whose first match is the second range.
    expect(currentMatchIndex(t, ms, "stale badge")).toBe(1);
    expect(currentMatchIndex(t, ms, "zzz")).toBe(-1);
  });
  it("a case-sensitive query lands on the capitalised term's match, the one the preview paints", () => {
    const t = "`Fingerprint` carries HeadOid now. The fingerprint now has it.";
    const q = "HeadOid fingerprint";
    const ms = queryMatches(t, q);
    // Exact over the whole query: "Fingerprint" is not a match, "fingerprint" is.
    expect(ms.map((m) => t.slice(m.start, m.end))).toEqual(["HeadOid", "fingerprint"]);
    expect(handoffQuery(q)).toBe("HeadOid");
    expect(currentMatchIndex(t, ms, q)).toBe(0);
  });
});

describe("fitSnippet", () => {
  it("cuts the text before the first match to a few words, at a word start, and moves the ranges", () => {
    const snippet = "…whether to refresh a PR's badge by comparing a fingerprint built from";
    const at = snippet.indexOf("fingerprint");
    const fit = fitSnippet(snippet, [{ start: at, end: at + 11 }]);
    expect(fit.text).toBe("…badge by comparing a fingerprint built from");
    expect(fit.ranges.map((r) => fit.text.slice(r.start, r.end))).toEqual(["fingerprint"]);
  });
  it("keeps a snippet whose match is near its start", () => {
    expect(fitSnippet("The fingerprint is", [{ start: 4, end: 15 }])).toEqual({ text: "The fingerprint is", ranges: [{ start: 4, end: 15 }] });
  });
  it("never starts inside an emoji: it moves on to the next word", () => {
    const snippet = `${"x".repeat(14)}🐛${"y".repeat(10)} so 🐛 bug`;
    const at = snippet.indexOf("bug");
    const fit = fitSnippet(snippet, [{ start: at, end: at + 3 }], 18);
    expect(fit.text).toBe("…so 🐛 bug");
    expect(fit.ranges.map((r) => fit.text.slice(r.start, r.end))).toEqual(["bug"]);
  });
});

describe("textRuns", () => {
  it("cuts a text at its ranges", () => {
    expect(textRuns("a fix b", [{ start: 2, end: 5 }])).toEqual([
      { text: "a ", hit: false },
      { text: "fix", hit: true },
      { text: " b", hit: false },
    ]);
    expect(textRuns("fix", [{ start: 0, end: 3 }])).toEqual([{ text: "fix", hit: true }]);
    expect(textRuns("", [])).toEqual([{ text: "", hit: false }]);
  });
});

const hit = (threadId: string, itemId: string, speaker: SearchHitView["speaker"] = "assistant"): SearchHitView => ({ threadId, itemId, ordinal: 1, speaker, createdAtMs: 0, snippet: "x", ranges: [] });
const group = (threadId: string, hits: SearchHitView[], totalHits = hits.length): SearchGroupView => ({ threadId, threadName: threadId, archived: false, totalHits, hits });
function result(over: Partial<SearchResultView> = {}): SearchResultView {
  return {
    query: "q",
    threads: [{ threadId: "s-n", name: "Name q", ranges: [], archived: true, lastActivityMs: 0 }],
    groups: [group("s-1", [hit("s-1", "a"), hit("s-1", "b", "user"), hit("s-1", "c")], 6), group("s-2", [hit("s-2", "d")])],
    caseSensitive: false,
    namesOnly: false,
    totalHits: 7,
    totalThreads: 2,
    truncated: false,
    ...over,
  };
}

describe("searchRows", () => {
  it("lists Threads, then Messages by thread with up to the shown hits and N more", () => {
    expect(searchRows(result()).map((r) => r.key)).toEqual(["sec:threads", "name:s-n", "sec:messages", "group:s-1", "hit:s-1:a", "hit:s-1:b", "hit:s-1:c", "more:s-1", "group:s-2", "hit:s-2:d"]);
    const more = searchRows(result()).find((r) => r.kind === "more");
    expect(more?.kind === "more" && more.count).toBe(3);
  });
  it("heads Messages with the totals", () => {
    expect(messagesLabel({ totalHits: 14, totalThreads: 4 })).toBe("Messages · 14 in 4 threads");
    expect(messagesLabel({ totalHits: 1, totalThreads: 1 })).toBe("Messages · 1 in 1 thread");
  });
  it("leaves out an empty section and adds a quiet note for names only, a truncated read or more threads than shown", () => {
    expect(searchRows(result({ threads: [], groups: [], namesOnly: true, totalHits: 0, totalThreads: 0 })).map((r) => r.key)).toEqual(["note:names"]);
    expect(searchRows(result({ truncated: true })).at(-1)?.key).toBe("note:truncated");
    expect(searchRows(result({ totalThreads: 5 })).at(-1)).toEqual({ kind: "note", key: "note:limit", text: "3 more threads have matches. More words narrow it." });
  });
});

describe("selection", () => {
  const rows = searchRows(result());
  it("starts on the first name or hit, never a heading", () => {
    expect(firstSelectable(rows)).toBe("name:s-n");
    expect(firstSelectable(searchRows(result({ threads: [] })))).toBe("hit:s-1:a");
    expect(firstSelectable([])).toBe("");
  });
  it("moves through names and hits only, skipping headers and more rows, and wraps", () => {
    const walk: string[] = [];
    let k = firstSelectable(rows);
    for (let i = 0; i < 6; i++) {
      walk.push(k);
      k = moveSelection(rows, k, 1);
    }
    expect(walk).toEqual(["name:s-n", "hit:s-1:a", "hit:s-1:b", "hit:s-1:c", "hit:s-2:d", "name:s-n"]);
    expect(moveSelection(rows, "name:s-n", -1)).toBe("hit:s-2:d");
    expect(moveSelection(rows, "gone", -1)).toBe("hit:s-2:d");
    expect(moveSelection([], "x", 1)).toBe("");
  });
  it("keeps the row for the same query answered again, else starts over", () => {
    expect(keepSelection(rows, "hit:s-1:c", true)).toBe("hit:s-1:c");
    expect(keepSelection(rows, "hit:s-1:c", false)).toBe("name:s-n");
    expect(keepSelection(rows, "hit:gone", true)).toBe("name:s-n");
  });
});

describe("dayLabel", () => {
  const now = new Date(2026, 10, 3, 15, 0).getTime();
  it("shows the time today, the day this year, the year before", () => {
    expect(dayLabel(new Date(2026, 10, 3, 9, 5).getTime(), now)).toMatch(/09:05|9:05/);
    expect(dayLabel(new Date(2026, 9, 19, 9, 5).getTime(), now)).toMatch(/Oct 19/);
    expect(dayLabel(new Date(2025, 9, 19).getTime(), now)).toMatch(/2025/);
    expect(dayLabel(null, now)).toBe("");
  });
});
