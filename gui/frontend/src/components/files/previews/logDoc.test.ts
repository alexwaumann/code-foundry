import { describe, expect, it } from "vitest";
import { blankFile } from "@/api/files";
import { lineCount } from "../fileKind";
import { DEBUG, ERROR, FATAL, INFO, WARN } from "./logLine";
import { docOf, filterCount, filterRows, lineEnd, parseLog, plainText, rowOf, sameLine, utf8Length } from "./logDoc";

const E = "\u001b";

const DAEMON = [
  'time=2026-11-14T09:14:02.113-08:00 level=INFO msg="daemon listening" port=7421',
  'time=2026-11-14T09:14:02.131-08:00 level=DEBUG msg="fsevents stream started" paths=6',
  'time=2026-11-14T09:14:09.902-08:00 level=WARN msg="gh rate limit low" remaining=112',
  'time=2026-11-14T09:15:47.224-08:00 level=ERROR msg="worktree add failed" project=code-foundry',
  "fatal: a branch named 'cf/file-formats' already exists",
  "goroutine 84 [running]:",
  "\tinternal/store/project/worktree.go:212 +0x1c4",
  "",
  'time=2026-11-14T09:15:47.229-08:00 level=INFO msg="thread stopped" reason=crashed',
].join("\n");

describe("parseLog", () => {
  it("counts lines as the code view does", () => {
    for (const t of ["", "a", "a\n", "a\nb", "a\n\n", "\n", "a\r\nb\r\n"]) expect(parseLog(t, true).lines).toBe(lineCount(t));
  });

  it("finds levels, and a stack trace keeps its entry's", () => {
    const doc = parseLog(DAEMON, true);
    expect([...doc.levels]).toEqual([INFO, DEBUG, WARN, ERROR, ERROR, ERROR, ERROR, ERROR, INFO]);
    expect([...doc.own]).toEqual([1, 1, 1, 1, 0, 0, 0, 0, 1]);
    expect(doc.leveled).toBe(true);
    expect(filterCount(doc, ERROR)).toBe(5);
    expect(filterCount(doc, "all")).toBe(9);
    expect([...(filterRows(doc, ERROR) ?? [])]).toEqual([3, 4, 5, 6, 7]);
    expect(filterRows(doc, "all")).toBeNull();
  });

  it("an entry with a timestamp and no level ends the one above", () => {
    const doc = parseLog("09:00:00 ERROR boom\n  at x\n09:00:01 plain entry\n  its detail", true);
    expect([...doc.levels]).toEqual([ERROR, ERROR, 0, 0]);
  });

  it("Error takes FATAL too", () => {
    const doc = parseLog('{"level":60,"msg":"x"}\n{"level":50,"msg":"y"}\n', true);
    expect([...doc.levels]).toEqual([FATAL, ERROR]);
    expect(filterCount(doc, ERROR)).toBe(2);
  });

  it("terminal output is not read for levels", () => {
    const doc = parseLog(`${E}[31mERROR${E}[0m one\n[WARN] two\n`, false);
    expect(doc.leveled).toBe(false);
    expect([...doc.levels]).toEqual([0, 0]);
    expect(doc.timeCols).toBe(0);
  });

  it("levels are found under colour codes", () => {
    const doc = parseLog(`2026-11-14T09:00:00Z ${E}[33mWARN${E}[0m slow\n`, true);
    expect([...doc.levels]).toEqual([WARN]);
    expect(doc.timeCols).toBe(8);
  });

  it("carries the pen from line to line", () => {
    const doc = parseLog(`${E}[32mgreen\nstill green\n${E}[0mplain\n`, false);
    expect(doc.pens?.map((p) => p.fg)).toEqual([null, 2, 2]);
    expect(rowOf(doc, 1).runs).toEqual([{ from: 0, to: 11, style: doc.pens?.[1] }]);
    expect(rowOf(doc, 2).runs).toEqual([]);
  });

  it("an escape at a chunk edge (cut by the tail read) is dropped, not shown", () => {
    // The read began inside "\x1b[31m": its first line starts with "1m".
    const doc = parseLog(`1mred${E}[0m\nnext\n`, false);
    expect(rowOf(doc, 0).text).toBe("1mred");
    expect(rowOf(doc, 1).text).toBe("next");
  });

  it("hostile input: NUL bytes, a 1 MiB single line, mixed formats", () => {
    const nul = parseLog("a\u0000b\n", true);
    expect(rowOf(nul, 0).text).toBe("a␀b");
    const long = parseLog(`${E}[31m${"x".repeat(1 << 20)}`, false);
    expect(long.lines).toBe(1);
    expect(long.cols).toBe(1 << 20);
    const mixed = parseLog([DAEMON, '{"level":"warn","msg":"json too"}', "[error] bracketed", `${E}[36mcyan${E}[0m INFO coloured`, "plain words"].join("\n"), true);
    expect([...mixed.levels].slice(-4)).toEqual([WARN, ERROR, INFO, INFO]);
  });

  it("measures the widest line after escapes", () => {
    expect(parseLog(`${E}[1mabc${E}[0m\nab\n`, false).cols).toBe(3);
    expect(parseLog("abcdef\rxy\n", true).cols).toBe(6);
  });

  it("lineEnd leaves out CR and LF", () => {
    const doc = parseLog("ab\r\ncd\r\n", true);
    expect(doc.text.slice(doc.starts[0], lineEnd(doc, 0))).toBe("ab");
    expect(doc.text.slice(doc.starts[1], lineEnd(doc, 1))).toBe("cd");
  });
});

describe("docOf", () => {
  it("parses a read once", () => {
    const file = { ...blankFile("/w/a.log"), text: DAEMON };
    expect(docOf(file, true)).toBe(docOf(file, true));
    expect(docOf(file, false)).not.toBe(docOf(file, true));
    expect(docOf({ ...file }, true)).not.toBe(docOf(file, true));
  });
});

describe("plainText", () => {
  it.each([
    ["untouched without escapes", "a\nb\n", "a\nb\n"],
    ["escapes stripped", `${E}[31mred${E}[0m\n`, "red\n"],
    ["overwrites collapsed", "10%\r100%\n", "100%\n"],
  ])("%s", (_name, text, want) => {
    expect(plainText(text)).toBe(want);
  });
});

describe("sameLine", () => {
  it.each([
    ["ASCII", "a"],
    ["two bytes", "é"],
    ["three bytes", "€"],
    ["four bytes", "😀"],
  ])("utf8Length: %s", (_name, s) => {
    expect(utf8Length(s, 0, s.length)).toBe(new TextEncoder().encode(s).length);
  });

  it("finds the line again after the tail moved on", () => {
    const lines = Array.from({ length: 10 }, (_, i) => `line ${String(i)} ünïcode`);
    const text = (from: number, to: number) => lines.slice(from, to).join("\n") + "\n";
    const bytes = (n: number) => new TextEncoder().encode(text(0, n)).length;
    const prev = parseLog(text(2, 8), true, bytes(2));
    const next = parseLog(text(4, 10), true, bytes(4));
    // Line 3 of prev is "line 5"; in next it is line 1.
    expect(prev.text.split("\n")[3]).toBe(lines[5]);
    expect(sameLine(prev, 3, next)).toBe(1);
    // A line no longer read gives the first.
    expect(sameLine(prev, 0, next)).toBe(0);
    // The same read: the same line.
    expect(sameLine(prev, 3, prev)).toBe(3);
  });
});
