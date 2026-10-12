import { describe, expect, it } from "vitest";
import { addedHunks, changedSpans, diffLines, diffStats, editHunks, hunkHeader, markWords, patchHunks, splitLines } from "./diff";

const ops = (a: string, b: string) => diffLines(splitLines(a), splitLines(b)).map((o) => `${{ ctx: " ", add: "+", del: "-" }[o.kind]}${o.text}`);

describe("diffLines", () => {
  it.each([
    ["a\nb\nc", "a\nb\nc", [" a", " b", " c"]],
    ["a\nb\nc", "a\nx\nc", [" a", "-b", "+x", " c"]],
    ["a\nc", "a\nb\nc", [" a", "+b", " c"]],
    ["a\nb\nc", "a\nc", [" a", "-b", " c"]],
    ["", "x\ny", ["+x", "+y"]],
    ["x\n", "", ["-x"]],
    ["a\nb\nc\nd", "b\nc\nd\ne", ["-a", " b", " c", " d", "+e"]],
  ])("%j → %j", (a, b, want) => {
    expect(ops(a, b)).toEqual(want);
  });
});

describe("editHunks", () => {
  it("numbers lines and keeps context around the change", () => {
    const old = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"].join("\n");
    const neu = old.replace("5", "five");
    const [h, ...rest] = editHunks(old, neu, { context: 2 });
    expect(rest).toEqual([]);
    expect(h && hunkHeader(h)).toBe("@@ -3,5 +3,5 @@");
    expect(h?.lines.map((l) => [l.kind, l.text, l.oldNo, l.newNo])).toEqual([
      ["ctx", "3", 3, 3],
      ["ctx", "4", 4, 4],
      ["del", "5", 5, null],
      ["add", "five", null, 5],
      ["ctx", "6", 6, 6],
      ["ctx", "7", 7, 7],
    ]);
  });

  it("splits far-apart changes into hunks and merges close ones", () => {
    const old = Array.from({ length: 20 }, (_, i) => String(i + 1)).join("\n");
    expect(editHunks(old, old.replace(/^1$/m, "x").replace(/^20$/m, "y"), { context: 2 }).map(hunkHeader)).toEqual(["@@ -1,3 +1,3 @@", "@@ -18,3 +18,3 @@"]);
    expect(editHunks(old, old.replace(/^5$/m, "x").replace(/^9$/m, "y"), { context: 2 }).map(hunkHeader)).toEqual(["@@ -3,9 +3,9 @@"]);
    expect(editHunks("same", "same")).toEqual([]);
  });

  it("marks the changed words of a replaced line", () => {
    const [h] = editHunks("\tHeadOid string", "\tHeadOid int");
    expect(h?.lines.map((l) => l.mark)).toEqual([
      [9, 15],
      [9, 12],
    ]);
    // Nothing in common: the whole line is the change, no mark.
    const [w] = editHunks("abc", "xyz");
    expect(w?.lines.map((l) => l.mark)).toEqual([undefined, undefined]);
  });
});

describe("patchHunks", () => {
  it("maps Claude's structuredPatch with its line numbers", () => {
    const [h] = patchHunks([{ oldStart: 18, oldLines: 3, newStart: 18, newLines: 4, lines: [" type X struct {", "-\tA int", "+\tA int64", "+\tB string", "\\ No newline at end of file", " }"] }]);
    expect(h?.lines.map((l) => [l.kind, l.oldNo, l.newNo])).toEqual([
      ["ctx", 18, 18],
      ["del", 19, null],
      ["add", null, 19],
      ["add", null, 20],
      ["ctx", 20, 21],
    ]);
    expect(h && diffStats([h])).toEqual({ added: 2, removed: 1 });
  });
});

describe("addedHunks", () => {
  it("is one all-added hunk, or none for an empty file", () => {
    expect(addedHunks("a\nb\n").map((h) => [hunkHeader(h), h.lines.map((l) => l.newNo)])).toEqual([["@@ -0,0 +1,2 @@", [1, 2]]]);
    expect(addedHunks("")).toEqual([]);
  });
});

describe("markWords / changedSpans", () => {
  it("pairs only runs of equal length", () => {
    const h = markWords({
      oldStart: 1,
      oldLines: 2,
      newStart: 1,
      newLines: 1,
      lines: [
        { kind: "del", text: "a = 1", oldNo: 1, newNo: null },
        { kind: "del", text: "b = 2", oldNo: 2, newNo: null },
        { kind: "add", text: "a = 3", oldNo: null, newNo: 1 },
      ],
    });
    expect(h.lines.every((l) => l.mark === undefined)).toBe(true);
    expect(changedSpans("foo(bar)", "foo(baz)")).toEqual([
      [6, 7],
      [6, 7],
    ]);
  });
});
