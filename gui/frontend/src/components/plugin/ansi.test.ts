import { describe, expect, it, vi } from "vitest";
import { applySgr, index256, nearest16, parseAnsi, parseAnsiLine, sgrCss, stripAnsi, type AnsiSpan, type SgrStyle } from "./ansi";

const E = "\x1b";

/** A line's spans as [text, style] pairs (null: unstyled). */
function spans(line: string, start: SgrStyle = {}): [string, SgrStyle | null][] | string {
  const [l] = parseAnsiLine(line, start);
  return l.spans === null ? l.text : l.spans.map((s: AnsiSpan) => [s.text, s.style]);
}

describe("SGR sequences to spans", () => {
  it.each<[string, string, [string, SgrStyle | null][] | string]>([
    ["plain text", "hello", "hello"],
    ["a colour and a reset", `${E}[31mred${E}[0m done`, [["red", { fg: 1 }], [" done", null]]],
    ["an empty reset", `${E}[32mok${E}[m.`, [["ok", { fg: 2 }], [".", null]]],
    ["the 8 colours", `${E}[30ma${E}[37mb`, [["a", { fg: 0 }], ["b", { fg: 7 }]]],
    ["bright colours", `${E}[90ma${E}[97mb`, [["a", { fg: 8 }], ["b", { fg: 15 }]]],
    ["backgrounds", `${E}[41ma${E}[107mb${E}[49mc`, [["a", { bg: 1 }], ["b", { bg: 15 }], ["c", null]]],
    ["default foreground", `${E}[1;31ma${E}[39mb`, [["a", { bold: true, fg: 1 }], ["b", { bold: true }]]],
    ["bold, dim, italic, underline", `${E}[1ma${E}[2mb${E}[3mc${E}[4md`, [["a", { bold: true }], ["b", { bold: true, dim: true }], ["c", { bold: true, dim: true, italic: true }], ["d", { bold: true, dim: true, italic: true, underline: true }]]],
    ["22 clears bold and dim", `${E}[1;2ma${E}[22mb`, [["a", { bold: true, dim: true }], ["b", null]]],
    ["23 and 24", `${E}[3;4ma${E}[23mb${E}[24mc`, [["a", { italic: true, underline: true }], ["b", { underline: true }], ["c", null]]],
    ["underline styles by colon", `${E}[4:3ma${E}[4:0mb`, [["a", { underline: true }], ["b", null]]],
    ["256: a palette index", `${E}[38;5;9ma`, [["a", { fg: 9 }]]],
    ["256: the cube, nearest", `${E}[38;5;196ma`, [["a", { fg: 9 }]]],
    ["256: a grey, nearest", `${E}[48;5;244ma`, [["a", { bg: 8 }]]],
    ["truecolor, nearest", `${E}[38;2;0;200;0ma`, [["a", { fg: 2 }]]],
    ["truecolor by colons", `${E}[38:2::250:250:250ma`, [["a", { fg: 15 }]]],
    // 31, then an unreadable 38;5;300: the foreground is dropped.
    ["a bad extended colour is dropped", `${E}[31;38;5;300ma`, "a"],
    ["unknown codes are dropped", `${E}[5;7;9;53ma`, "a"],
    ["params after an extended colour", `${E}[38;5;1;1ma`, [["a", { fg: 1, bold: true }]]],
  ])("%s", (_name, line, want) => {
    expect(spans(line)).toEqual(want);
  });
});

describe("other escapes are dropped, never shown", () => {
  it.each<[string, string, string]>([
    ["cursor and erase", `${E}[2K${E}[1Gline${E}[?25l`, "line"],
    ["a private SGR-looking sequence", `${E}[>4;1mx`, "x"],
    ["an intermediate byte", `${E}[1 qx`, "x"],
    ["an OSC title ended by BEL", `${E}]0;title\x07after`, "after"],
    ["an OSC link ended by ST", `${E}]8;;https://x${E}\\link${E}]8;;${E}\\`, "link"],
    ["a charset", `${E}(Bplain`, "plain"],
    ["two-byte sequences", `${E}Mup${E}7`, "up"],
    ["a lone ESC at the end", `end${E}`, "end"],
    ["a cut CSI at the end", `end${E}[3`, "end"],
    ["an unterminated OSC", `a${E}]0;no end`, "a"],
    ["other control characters", "a\x07b\x08c\x00d\x7f", "abcd"],
    ["a tab stays", "a\tb", "a\tb"],
    ["a CRLF line end", "line\r", "line"],
    ["a redraw keeps what follows the CR", "10%\r20%\r30%", "30%"],
    ["UTF-8 stays", `✓ ${E}[32mpass${E}[0m ✗`, "✓ pass ✗"],
  ])("%s", (_name, line, want) => {
    expect(parseAnsiLine(line, {})[0].text).toBe(want);
  });

  it("strips a whole text", () => {
    expect(stripAnsi(`${E}[31ma${E}[0m\n${E}]0;t\x07b\n`)).toBe("a\nb\n");
  });
});

describe("parseAnsi", () => {
  it("carries the style from line to line", () => {
    const out = parseAnsi([`${E}[33mwarn`, "still yellow", `${E}[0mplain`, ""]);
    expect(out.map((l) => l.spans?.map((s) => [s.text, s.style]) ?? l.text)).toEqual([[["warn", { fg: 3 }]], [["still yellow", { fg: 3 }]], "plain", ""]);
  });

  it("keeps a redraw's style", () => {
    const [l, end] = parseAnsiLine(`${E}[31m10%\r20%`, {});
    expect(l.spans).toEqual([{ text: "20%", style: { fg: 1 } }]);
    expect(end).toEqual({ fg: 1 });
  });

  it("returns null spans for lines with no style, so they draw as text", () => {
    expect(parseAnsi(["a", `${E}[2Kb`, `${E}[1m${E}[0mc`]).map((l) => l.spans)).toEqual([null, null, null]);
  });

  it("is one pass over the Log's largest buffer", () => {
    // 2000 lines (LOG_MAX_LINES) of coloured test output, about 64 KB. The work is counted, not
    // timed (a busy machine slows any pass): the parser reads characters with charCodeAt, each
    // at most twice in one pass; going back over earlier text would read far more.
    const lines = Array.from({ length: 2000 }, (_, i) => `${E}[32m✓${E}[0m pkg/${String(i)} ${E}[1m${String(i)} passed${E}[22m`);
    const chars = lines.reduce((n, l) => n + l.length, 0);
    const reads = vi.spyOn(String.prototype, "charCodeAt");
    const out = parseAnsi(lines);
    const n = reads.mock.calls.length;
    reads.mockRestore();
    expect(out).toHaveLength(2000);
    expect(out[1999]?.text).toBe("✓ pkg/1999 1999 passed");
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(2 * chars);
  });
});

describe("colours", () => {
  it("maps RGB to the nearest of the 16", () => {
    expect(nearest16(0, 0, 0)).toBe(0);
    expect(nearest16(255, 255, 255)).toBe(15);
    expect(nearest16(200, 10, 10)).toBe(1);
    expect(nearest16(90, 90, 250)).toBe(12);
  });

  it.each<[number, number | undefined]>([
    [0, 0],
    [15, 15],
    [16, 0],
    [231, 15],
    [232, 0],
    [255, 7],
    [256, undefined],
    [-1, undefined],
    [1.5, undefined],
  ])("index256(%d)", (n, want) => {
    expect(index256(n)).toBe(want);
  });

  it("uses the theme's terminal palette", () => {
    expect(sgrCss({ fg: 9, bg: 0 })).toEqual({ color: "var(--terminal-ansi-9)", backgroundColor: "var(--terminal-ansi-0)" });
    expect(sgrCss({ bold: true })).toEqual({});
  });

  it("resets on 0 inside a sequence", () => {
    expect(applySgr({ fg: 1, bold: true }, "0;4")).toEqual({ underline: true });
  });
});
