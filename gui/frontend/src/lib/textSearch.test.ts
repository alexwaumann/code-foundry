import { describe, expect, it } from "vitest";
import type { TextFileView, TextLineView, TextSummaryView } from "@/api/textSearch";
import { countLabel, findBarQuery, firstMatch, keepMatch, lineRuns, matchPosition, matchRanges, moreLabel, moveMatch, queryReady, queryRegExp, searchKey, smartCaseSensitive, statusText, textRows, type MatchRow } from "./textSearch";

function line(n: number, text: string, ranges: [number, number][] = [], cut: { start?: boolean; end?: boolean } = {}): TextLineView {
  return { line: n, text, ranges: ranges.map(([start, end]) => ({ start, end })), cutStart: cut.start ?? false, cutEnd: cut.end ?? false };
}

function file(path: string, lines: TextLineView[], opts: Partial<TextFileView> = {}): TextFileView {
  return { projectId: "repo-cf", checkout: "/w/cf", path, ignored: false, lines, lineCount: lines.length, lineCountCapped: false, ...opts };
}

const SUMMARY: TextSummaryView = { lines: 0, files: 0, truncated: false, fileCapped: false, totalCapped: false, timedOut: false, caseSensitive: false, elapsedMs: 3, includedCapped: false };

/** Rows as short strings: "F name dir count", "M line", "N note". */
function shape(rows: ReturnType<typeof textRows>): string[] {
  return rows.map((r) => (r.kind === "file" ? `F ${r.name} ${r.dir || "-"} ${r.count}${r.project ? ` @${r.project}` : ""}${r.file.ignored ? " ignored" : ""}` : r.kind === "match" ? `M ${String(r.line.line)}` : `N ${r.text}`));
}

describe("queryReady", () => {
  it.each([
    ["", false],
    ["a", false],
    ["ab", true],
    ["  ", true],
    ["😀", false],
    ["😀x", true],
  ])("%j → %s", (q, want) => {
    expect(queryReady(q)).toBe(want);
  });
});

describe("searchKey", () => {
  it("changes with the query, each toggle and the checkouts", () => {
    const base = { query: "foo", matchCase: false, wholeWord: false, regex: false };
    const keys = new Set([searchKey(base, "a"), searchKey({ ...base, query: "fo" }, "a"), searchKey({ ...base, matchCase: true }, "a"), searchKey({ ...base, wholeWord: true }, "a"), searchKey({ ...base, regex: true }, "a"), searchKey(base, "b")]);
    expect(keys.size).toBe(6);
  });
});

describe("smart case (the daemon's)", () => {
  it.each<[string, boolean, boolean, boolean]>([
    ["home", false, false, false],
    ["Home", false, false, true],
    ["home", true, false, true],
    ["élan", false, false, false],
    ["Élan", false, false, true],
    ["\\W+", false, true, false],
    ["\\W+", false, false, true],
    ["\\p{Lu}x", false, true, false],
    ["\\x{41}", false, true, false],
    ["a\\sB", false, true, true],
  ])("%j matchCase=%s regex=%s → %s", (q, matchCase, regex, want) => {
    expect(smartCaseSensitive(q, matchCase, regex)).toBe(want);
  });
});

describe("queryRegExp and matchRanges", () => {
  it("matches a literal with its punctuation, case folded unless sensitive", () => {
    const re = queryRegExp({ query: "a.b(", wholeWord: false, regex: false }, false);
    expect(re && matchRanges(re, "A.B( a.b( axb(")).toEqual([
      { start: 0, end: 4 },
      { start: 5, end: 9 },
    ]);
    const exact = queryRegExp({ query: "a.b(", wholeWord: false, regex: false }, true);
    expect(exact && matchRanges(exact, "A.B( a.b(")).toEqual([{ start: 5, end: 9 }]);
  });

  it("whole words use Unicode letters", () => {
    const re = queryRegExp({ query: "née", wholeWord: true, regex: false }, false);
    expect(re && matchRanges(re, "née nées xnée née_ (née)")).toEqual([
      { start: 0, end: 3 },
      { start: 20, end: 23 },
    ]);
  });

  it("a regex: UTF-16 offsets past an emoji; empty matches skipped", () => {
    const re = queryRegExp({ query: "b*", wholeWord: false, regex: true }, true);
    expect(re && matchRanges(re, "😀bb a b")).toEqual([
      { start: 2, end: 4 },
      { start: 7, end: 8 },
    ]);
  });

  it("null for a regex JavaScript cannot compile, or no query", () => {
    expect(queryRegExp({ query: "(a", wholeWord: false, regex: true }, false)).toBeNull();
    expect(queryRegExp({ query: "", wholeWord: false, regex: false }, false)).toBeNull();
  });
});

describe("findBarQuery: what the File tab's find bar takes over", () => {
  const q = (query: string, o: { wholeWord?: boolean; regex?: boolean } = {}) => ({ query, matchCase: false, wholeWord: o.wholeWord ?? false, regex: o.regex ?? false });
  it.each<[string, ReturnType<typeof q>, boolean, string | null]>([
    ["a plain literal", q("render"), false, "render"],
    ["a literal with a capital (both smart case)", q("Render"), true, "Render"],
    ["spaces are text", q("func Home"), true, "func Home"],
    ["match case forced on a lower-case query: the bar would ignore case", q("render"), true, null],
    ["a regex", q("ren.er", { regex: true }), false, null],
    ["whole word", q("render", { wholeWord: true }), false, null],
  ])("%s", (_name, query, cs, want) => {
    expect(findBarQuery(query, cs)).toBe(want);
  });
});

describe("rows", () => {
  it("groups each file's lines under its header in the daemon's order, with a note when lines were held back", () => {
    const files = [
      file("internal/daemon/paths.go", [line(18, "a"), line(24, "b")], { lineCount: 3 }),
      file(".env.local", [line(3, "c")], { ignored: true }),
      file("Makefile", [line(62, "d")], { lineCount: 999, lineCountCapped: true }),
    ];
    expect(shape(textRows(files, {}, false))).toEqual(["F paths.go internal/daemon 3", "M 18", "M 24", "N 1 more in this file", "F .env.local - 1 ignored", "M 3", "F Makefile - 999+", "M 62", "N 998+ more in this file"]);
  });

  it("labels the project with several checkouts; a file found twice is kept once", () => {
    const files = [file("a.ts", [line(1, "x")]), file("a.ts", [line(1, "x")]), file("b.ts", [line(2, "y")], { projectId: "repo-gp", checkout: "/w/gp" })];
    expect(shape(textRows(files, { "repo-cf": "code-foundry", "repo-gp": "ghostty" }, true))).toEqual(["F a.ts - 1 @code-foundry", "M 1", "F b.ts - 1 @ghostty", "M 2"]);
  });

  it("counts and notes", () => {
    expect(countLabel({ lineCount: 12, lineCountCapped: false })).toBe("12");
    expect(countLabel({ lineCount: 999, lineCountCapped: true })).toBe("999+");
    expect(moreLabel({ lines: [line(1, "")], lineCount: 1, lineCountCapped: false })).toBeNull();
    expect(moreLabel({ lines: Array.from({ length: 50 }, (_, i) => line(i + 1, "")), lineCount: 312, lineCountCapped: false })).toBe("262 more in this file");
  });
});

describe("selection", () => {
  const rows = textRows([file("a.ts", [line(1, "x"), line(5, "y")]), file("b.ts", [line(9, "z")], { lineCount: 3 })], {}, false);
  const keys = rows.filter((r) => r.kind === "match").map((r) => r.key);

  it("only match rows take it, and it wraps both ways", () => {
    expect(firstMatch(rows)).toBe(keys[0]);
    expect(moveMatch(rows, keys[0] ?? "", 1)).toBe(keys[1]);
    expect(moveMatch(rows, keys[1] ?? "", 1)).toBe(keys[2]);
    expect(moveMatch(rows, keys[2] ?? "", 1)).toBe(keys[0]);
    expect(moveMatch(rows, keys[0] ?? "", -1)).toBe(keys[2]);
    expect(moveMatch(rows, "", -1)).toBe(keys[2]);
    expect(moveMatch([], "", 1)).toBe("");
  });

  it.each([
    { name: "the same answer keeps a match still listed", key: 1, same: true, want: 1 },
    { name: "a new answer starts at the first match", key: 1, same: false, want: 0 },
    { name: "a match that left gives way to the first", key: -1, same: true, want: 0 },
    { name: "a file row is no match: the first", key: -2, same: true, want: 0 },
  ])("keepMatch: $name", ({ key, same, want }) => {
    const k = key === -1 ? "gone" : key === -2 ? (rows.find((r) => r.kind !== "match")?.key ?? "") : (keys[key] ?? "");
    expect(keepMatch(rows, k, same)).toBe(keys[want]);
  });

  it("says where the match is in its file", () => {
    const m = rows.filter((r): r is MatchRow => r.kind === "match");
    expect(matchPosition(m[1] as MatchRow)).toBe("match 2 of 2 in this file");
    expect(matchPosition(m[2] as MatchRow)).toBe("match 1 of 3 in this file");
  });
});

describe("statusText", () => {
  it("counts what the files count while the stream runs, then the result with its notes", () => {
    const files = [file("a.ts", [line(1, "x")], { lineCount: 12 }), file("b.ts", [line(2, "y")])];
    expect(statusText([], null)).toEqual({ text: "Searching…", notes: [] });
    expect(statusText(files, null)).toEqual({ text: "Searching… 13 matches in 2 files", notes: [] });
    expect(statusText(files, SUMMARY)).toEqual({ text: "13 matches in 2 files", notes: [] });
    expect(statusText([file("a.ts", [line(1, "x")])], SUMMARY)).toEqual({ text: "1 match in 1 file", notes: [] });
    expect(statusText([], SUMMARY)).toEqual({ text: "No matches", notes: [] });
    expect(statusText(files, { ...SUMMARY, truncated: true, totalCapped: true, timedOut: true })).toEqual({ text: "13+ matches in 2 files", notes: ["stopped at 2,000 lines", "stopped after 15 s"] });
    expect(statusText([file("a.ts", [line(1, "x")], { lineCount: 999, lineCountCapped: true })], { ...SUMMARY, truncated: true, fileCapped: true }).text).toBe("999+ matches in 1 file");
    expect(statusText([], { ...SUMMARY, includedCapped: true })).toEqual({ text: "No matches", notes: ["searched the first 20,000 included files"] });
  });
});

describe("lineRuns: a line as a narrow row draws it", () => {
  const show = (l: TextLineView) => {
    const r = lineRuns(l);
    return `${r.lead ? "…" : ""}${r.runs.map((x) => (x.hit ? `[${x.text}]` : x.text)).join("")}${r.trail ? "…" : ""}`;
  };
  it("drops indentation, keeps the matches", () => {
    expect(show(line(1, "\t\tif h := os.Getenv(x)", [[13, 19]]))).toBe("if h := os.[Getenv](x)");
  });
  it("keeps indentation a match is in", () => {
    expect(show(line(1, "  x", [[0, 2]]))).toBe("[  ]x");
  });
  it("tints non-ASCII text by its UTF-16 ranges (api/textSearch maps code points)", () => {
    // "日本😀 Café": the daemon's code points 4..8 are UTF-16 5..9.
    expect(show(line(1, "日本😀 Café", [[5, 9]]))).toBe("日本😀 [Café]");
  });
  it("ellipses where the daemon cut the line", () => {
    expect(show(line(1, "abc needle def", [[4, 10]], { start: true, end: true }))).toBe("…abc [needle] def…");
  });
  it("cuts in front so a far match shows, with one ellipsis", () => {
    const text = `${"word ".repeat(12)}needle`;
    expect(show(line(1, text, [[60, 66]], { start: true }))).toBe("…word word word word [needle]");
  });
});
