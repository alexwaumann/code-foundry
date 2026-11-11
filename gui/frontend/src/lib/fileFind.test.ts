import { describe, expect, it } from "vitest";
import { fileCountLabel, fileMatchIndex, findInFile, firstFrom, nearestMatch, pickCurrent, type FileMatch, type PickInput } from "./fileFind";

const spans = (text: string, query: string, max?: number) => findInFile(text, query, max).matches.map((m) => [m.line, m.nth, m.start, m.end]);

describe("findInFile", () => {
  it.each([
    { name: "one line", text: "a cat, a cat", query: "cat", want: [[0, 0, 2, 5], [0, 1, 9, 12]] },
    { name: "per line, nth restarting on each", text: "cat\nno\ncat cat\n", query: "cat", want: [[0, 0, 0, 3], [2, 0, 0, 3], [2, 1, 4, 7]] },
    { name: "CRLF breaks: offsets are in the line", text: "x\r\nab cat\r\ncat", query: "cat", want: [[1, 0, 3, 6], [2, 0, 0, 3]] },
    { name: "a lone CR breaks a line, as the library splits", text: "a\rcat", query: "cat", want: [[1, 0, 0, 3]] },
    { name: "smart case: lower case matches any", text: "Cat cat CAT", query: "cat", want: [[0, 0, 0, 3], [0, 1, 4, 7], [0, 2, 8, 11]] },
    { name: "smart case: a capital is exact", text: "Cat cat CAT", query: "Cat", want: [[0, 0, 0, 3]] },
    { name: "not overlapping", text: "aaaa", query: "aa", want: [[0, 0, 0, 2], [0, 1, 2, 4]] },
    { name: "a tab is text", text: "\tx = 1", query: "\tx", want: [[0, 0, 0, 2]] },
    { name: "an empty query finds nothing", text: "abc", query: "", want: [] },
    { name: "a query with a line break finds nothing", text: "a\nb", query: "a\nb", want: [] },
  ])("$name", ({ text, query, want }) => {
    expect(spans(text, query)).toEqual(want);
  });

  it("caps the count and says so", () => {
    const r = findInFile("x".repeat(30), "x", 10);
    expect(r.matches).toHaveLength(10);
    expect(r.capped).toBe(true);
    expect(findInFile("xx", "x", 10).capped).toBe(false);
  });
});

const ms = (text: string, query: string): FileMatch[] => findInFile(text, query).matches;

describe("stepping and keeping a match", () => {
  const text = "cat\n\ncat cat\nx\ncat";
  const matches = ms(text, "cat"); // lines 0, 2, 2, 4

  it("finds a match by its key", () => {
    expect(fileMatchIndex(matches, { line: 2, nth: 1 })).toBe(2);
    expect(fileMatchIndex(matches, { line: 3, nth: 0 })).toBe(-1);
    expect(fileMatchIndex(matches, null)).toBe(-1);
  });

  it.each([
    { line: 0, column: 0, want: 0 },
    { line: 1, column: 0, want: 1 },
    { line: 2, column: 1, want: 2 },
    { line: 3, column: 0, want: 3 },
    { line: 9, column: 0, want: 0 }, // past the last: wraps to the first
  ])("first from line $line column $column is $want", ({ line, column, want }) => {
    expect(firstFrom(matches, line, column)).toBe(want);
  });

  it("the nearest match to a place: its line first, then its column", () => {
    expect(nearestMatch(matches, 2, 5)).toBe(2);
    expect(nearestMatch(matches, 3, 0)).toBe(1);
    expect(nearestMatch([], 0, 0)).toBe(-1);
  });

  it.each([
    { query: "", index: 0, total: 3, capped: false, want: "" },
    { query: "a", index: -1, total: 3, capped: false, want: "0 of 3" },
    { query: "a", index: 1, total: 3, capped: false, want: "2 of 3" },
    { query: "a", index: 0, total: 10000, capped: true, want: "1 of 10000+" },
    { query: "a", index: -1, total: 0, capped: false, want: "0 of 0" },
  ])("count label $want", ({ query, index, total, capped, want }) => {
    expect(fileCountLabel(query, index, total, capped)).toBe(want);
  });
});

describe("pickCurrent", () => {
  const matches = ms("cat\n\ncat cat\nx\ncat", "cat"); // lines 0, 2, 2, 4
  const base: PickInput = { first: false, queryChanged: false, textChanged: false, matches, current: null, was: undefined, anchor: null, top: () => 0 };

  it("nothing to pick without matches", () => {
    expect(pickCurrent({ ...base, matches: [], first: true })).toEqual({ index: -1, reveal: false });
  });

  it("opening picks the first match at or below the top of the view, and reveals it", () => {
    expect(pickCurrent({ ...base, first: true, top: () => 3 })).toEqual({ index: 3, reveal: true });
  });

  it("a tab coming back to an open bar keeps its match, in place", () => {
    expect(pickCurrent({ ...base, first: true, current: { line: 2, nth: 1 }, top: () => 4 })).toEqual({ index: 2, reveal: false });
  });

  it("typing goes on from the match that was current, at or after its start", () => {
    const narrower = ms("cat\n\ncat cats\nx\ncats", "cats"); // lines 2 (col 4), 4
    const was = matches[2];
    expect(pickCurrent({ ...base, queryChanged: true, matches: narrower, was })).toEqual({ index: 0, reveal: true });
  });

  it("typing through a query with no match goes on from where the last one was", () => {
    expect(pickCurrent({ ...base, queryChanged: true, anchor: { line: 3, start: 0 }, top: () => 0 })).toEqual({ index: 3, reveal: true });
  });

  it("an edit of the text keeps the nearest match, without scrolling", () => {
    const edited = ms("cat\n\nxx cat cat\nx\ncat", "cat");
    expect(pickCurrent({ ...base, textChanged: true, matches: edited, current: { line: 2, nth: 0 }, was: matches[1] })).toEqual({ index: 1, reveal: false });
  });

  it("matches arriving after none take the first from the top, without scrolling", () => {
    expect(pickCurrent({ ...base, textChanged: true, top: () => 2 })).toEqual({ index: 1, reveal: false });
  });

  it("leaves the match when neither the query nor the text changed", () => {
    expect(pickCurrent(base)).toBeNull();
  });
});
