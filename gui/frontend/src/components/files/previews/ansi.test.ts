import { describe, expect, it } from "vitest";
import { ansiLine, applySgr, BOLD, colorCss, DIM, hasAnsi, INVERSE, ITALIC, PLAIN, STRIKE, stripAnsi, styleCss, UNDERLINE, type AnsiStyle } from "./ansi";

const E = "\u001b";

/** A line as "text|from-to:fg/bg/flags,…" for compact tables. */
function show(raw: string, start: AnsiStyle = PLAIN): string {
  const r = ansiLine(raw, start);
  const runs = r.runs.map((x) => `${String(x.from)}-${String(x.to)}:${String(x.style.fg)}/${String(x.style.bg)}/${String(x.style.flags)}`);
  return [r.plain, ...runs].join("|");
}

describe("applySgr", () => {
  it.each<[string, string, Partial<AnsiStyle>]>([
    ["reset by empty params", "", PLAIN],
    ["reset by 0", "0", PLAIN],
    ["a colour", "31", { fg: 1, bg: null, flags: 0 }],
    ["bold and a colour", "1;32", { fg: 2, flags: BOLD }],
    ["bright foreground", "91", { fg: 9 }],
    ["background", "44", { bg: 4 }],
    ["bright background", "103", { bg: 11 }],
    ["256 colours", "38;5;208", { fg: 208 }],
    ["256 background", "48;5;17", { bg: 17 }],
    ["true colour", "38;2;255;128;0", { fg: "#ff8000" }],
    ["true colour, colon form with colour space", "38:2::1:2:3", { fg: "#010203" }],
    ["true colour, colon form without", "48:2:1:2:3", { bg: "#010203" }],
    ["256 colours, colon form", "38:5:99", { fg: 99 }],
    ["dim italic underline inverse strike", "2;3;4;7;9", { flags: DIM | ITALIC | UNDERLINE | INVERSE | STRIKE }],
    ["curly underline", "4:3", { flags: UNDERLINE }],
    ["a cut-short 38 stops there", "38;5", PLAIN],
    ["out of range clamps", "38;2;999;-4;12", { fg: "#ff000c" }],
    ["unknown codes are ignored", "5;53;31", { fg: 1 }],
  ])("%s", (_name, params, want) => {
    expect(applySgr(PLAIN, params)).toMatchObject(want);
  });

  it.each<[string, AnsiStyle, string, Partial<AnsiStyle>]>([
    ["22 ends bold and dim", { fg: 1, bg: null, flags: BOLD | DIM | ITALIC }, "22", { fg: 1, flags: ITALIC }],
    ["39 and 49 reset the colours", { fg: 1, bg: 2, flags: 0 }, "39;49", PLAIN],
    ["23 24 27 29", { fg: null, bg: null, flags: ITALIC | UNDERLINE | INVERSE | STRIKE }, "23;24;27;29", PLAIN],
  ])("%s", (_name, from, params, want) => {
    expect(applySgr(from, params)).toMatchObject(want);
  });

  it("returns the one PLAIN when nothing is left, and the same style when nothing changed", () => {
    expect(applySgr({ fg: 1, bg: null, flags: 0 }, "39")).toBe(PLAIN);
    const s = applySgr(PLAIN, "31");
    expect(applySgr(s, "31")).toBe(s);
  });
});

describe("ansiLine", () => {
  it.each<[string, string, string]>([
    ["plain text", "hello", "hello"],
    ["a coloured word", `a ${E}[31mred${E}[0m b`, "a red b|2-5:1/null/0"],
    ["styles merge into one run", `${E}[1m${E}[1mab${E}[1mc${E}[0m`, "abc|0-3:null/null/1"],
    ["cursor and erase sequences are dropped", `${E}[2J${E}[H${E}[?25lhi${E}[?25h`, "hi"],
    ["an OSC title ended by BEL", `${E}]0;title\u0007after`, "after"],
    ["an OSC 8 hyperlink keeps its text", `${E}]8;;https://x.dev${E}\\link${E}]8;;${E}\\ end`, "link end"],
    ["a charset switch", `${E}(Bok`, "ok"],
    ["two-byte escapes", `${E}7a${E}8b${E}=c`, "abc"],
    ["an unterminated CSI at the end", `text${E}[31`, "text"],
    ["a CSI cut by a bad byte keeps that byte", `a${E}[3éb`, "aéb"],
    ["an unterminated OSC drops the rest", `a${E}]0;never ends`, "a"],
    ["a lone ESC at the end", `a${E}`, "a"],
    ["CRLF", "line\r", "line"],
    ["a progress bar collapses to its last state", "  0%\r 50%\r100% done", "100% done"],
    ["a shorter overwrite keeps the tail, as a terminal does", "abcdef\rxy", "xycdef"],
    ["erase to the end after a CR", `downloading 10 files\r${E}[Kdone`, "done"],
    ["erase the whole line, then write", `old text${E}[2K\rnew`, "new"],
    ["backspace overstrike", "ab\bc", "ac"],
    ["cursor to column", `abcdef${E}[3GX`, "abXdef"],
    ["cursor back and forward", `abcdef${E}[2DX${E}[1CY`, "abcdXfY"],
    ["a coloured progress bar", `${E}[32m 10%${E}[0m\r${E}[32m100%${E}[0m`, "100%|0-4:2/null/0"],
    ["NUL shows as a control picture", "a\u0000b", "a␀b"],
    ["BEL alone shows nothing", "a\u0007b", "ab"],
    ["tabs stay", "a\tb", "a\tb"],
    ["emoji survive an overwrite", "😀😀\rx", "x😀"],
  ])("%s", (_name, raw, want) => {
    expect(show(raw)).toBe(want);
  });

  it("carries the pen into the next line and out of it", () => {
    const a = ansiLine(`${E}[33mwarn`);
    expect(a.end.fg).toBe(3);
    const b = ansiLine(`still yellow${E}[0m plain`, a.end);
    expect(b.runs).toEqual([{ from: 0, to: 12, style: a.end }]);
    expect(b.end).toBe(PLAIN);
  });

  it("an escape split at a line edge is dropped on both sides", () => {
    // "\x1b[3" ends one line, "1mred" starts the next: neither is a sequence.
    expect(ansiLine(`a${E}[3`).plain).toBe("a");
    expect(ansiLine("1mred").plain).toBe("1mred");
  });

  it("a 1 MiB line with escapes every few bytes", () => {
    const raw = `${E}[31mab${E}[0mcd`.repeat(Math.ceil((1 << 20) / 13));
    const t = performance.now();
    const r = ansiLine(raw);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(r.plain.length).toBe(4 * Math.ceil((1 << 20) / 13));
    expect(r.runs.length).toBe(Math.ceil((1 << 20) / 13));
  });
});

describe("stripAnsi and hasAnsi", () => {
  it("strips across lines with the pen carried", () => {
    expect(stripAnsi(`${E}[1mbold\nstill${E}[0m\n\rover\n`)).toBe("bold\nstill\nover\n");
  });

  it.each([
    ["plain", "no escapes here", false],
    ["CSI", `a${E}[0m`, true],
    ["ESC without [", `a${E}]0;t\u0007`, false],
  ])("%s", (_name, text, want) => {
    expect(hasAnsi(text)).toBe(want);
  });
});

describe("colours and CSS", () => {
  it.each<[number | string, string]>([
    [1, "var(--terminal-ansi-1)"],
    [15, "var(--terminal-ansi-15)"],
    [16, "#000000"],
    [196, "#ff0000"],
    [208, "#ff8700"],
    [231, "#ffffff"],
    [232, "#080808"],
    [255, "#eeeeee"],
    ["#123456", "#123456"],
  ])("%s", (c, want) => {
    expect(colorCss(c)).toBe(want);
  });

  it("maps a style, inverse swapping the defaults", () => {
    expect(styleCss({ fg: 1, bg: null, flags: BOLD | UNDERLINE | STRIKE | DIM | ITALIC })).toEqual({ color: "var(--terminal-ansi-1)", fontWeight: 700, fontStyle: "italic", textDecorationLine: "underline line-through", opacity: 0.6 });
    expect(styleCss({ fg: null, bg: null, flags: INVERSE })).toEqual({ color: "var(--cf-surface)", backgroundColor: "var(--cf-text)" });
    expect(styleCss({ fg: 2, bg: 0, flags: INVERSE })).toEqual({ color: "var(--terminal-ansi-0)", backgroundColor: "var(--terminal-ansi-2)" });
  });
});
