import { Terminal } from "@xterm/xterm";
import { describe, expect, it } from "vitest";
import { clampCounts } from "./counts";
import { XtermRenderer } from "./xterm";

const MAX = 2147483647;
const encode = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);
const grid = { rows: 24, cols: 80 };

describe("clampCounts", () => {
  it.each([
    { name: "plain text", input: "hello [100S" },
    { name: "a count at the rows", input: "\x1b[24S" },
    { name: "a count at the columns", input: "\x1b[80I" },
    { name: "a tab count past the rows only", input: "\x1b[25Z" },
    { name: "no count", input: "\x1b[S" },
    { name: "a zero count", input: "\x1b[0M" },
    { name: "another final", input: "\x1b[100A\x1b[100b\x1b[100m" },
    { name: "a private prefix", input: "\x1b[?100S" },
    { name: "an intermediate", input: "\x1b[100 S" },
    { name: "a second param", input: "\x1b[100;5S" },
    { name: "a sub parameter", input: "\x1b[100:5S" },
    { name: "a sequence cut off by the chunk", input: "\x1b[100" },
    { name: "a lone ESC at the end", input: "A\x1b" },
  ])("leaves $name alone", ({ input }) => {
    const data = encode(input);
    expect(clampCounts(data, grid)).toBe(data);
  });

  it.each([
    { name: "one past the rows", input: "\x1b[25S", want: "\x1b[24S" },
    { name: "one past the columns", input: "\x1b[81I", want: "\x1b[80I" },
    { name: "SU", input: `\x1b[${String(MAX)}S`, want: "\x1b[24S" },
    { name: "SD", input: `\x1b[${String(MAX)}T`, want: "\x1b[24T" },
    { name: "IL", input: `\x1b[${String(MAX)}L`, want: "\x1b[24L" },
    { name: "DL", input: `\x1b[${String(MAX)}M`, want: "\x1b[24M" },
    { name: "CHT", input: `\x1b[${String(MAX)}I`, want: "\x1b[80I" },
    { name: "CBT", input: `\x1b[${String(MAX)}Z`, want: "\x1b[80Z" },
    { name: "more digits than a double holds", input: `\x1b[${"9".repeat(400)}S`, want: "\x1b[24S" },
    { name: "leading zeros", input: "\x1b[00025T", want: "\x1b[24T" },
    { name: "several, with text between", input: "é\x1b[99S你\x1b[99I\x1b[3S\x1b[99Zend", want: "é\x1b[24S你\x1b[80I\x1b[3S\x1b[80Zend" },
    { name: "one that ends an OSC string", input: "\x1b]0;title\x1b[99S", want: "\x1b]0;title\x1b[24S" },
  ])("clamps $name", ({ input, want }) => {
    const data = encode(input);
    expect(decode(clampCounts(data, grid))).toBe(want);
    expect(decode(data)).toBe(input);
  });
});

describe("XtermRenderer counts past the grid", () => {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)}`).join("\r\n");
  const everyColumnAStop = `\x1b[3g${Array.from({ length: 80 }, (_, c) => `\x1b[${String(c + 1)}G\x1bH`).join("")}`;

  const screens = [
    { screen: "a full screen", setup: `${lines}\x1b[10;5H` },
    { screen: "scroll margins", setup: `${lines}\x1b[5;15r\x1b[8;3H` },
    { screen: "the cursor below the margins", setup: `${lines}\x1b[5;15r\x1b[20;3H` },
    { screen: "a coloured background", setup: `${lines}\x1b[44m\x1b[10;5H` },
    { screen: "the alternate screen", setup: `\x1b[?1049h${lines}\x1b[10;5H` },
    { screen: "a tab stop in every column", setup: `${everyColumnAStop}\x1b[1;40H` },
    { screen: "no tab stops", setup: "\x1b[3g\x1b[1;40H" },
    { screen: "a pending wrap", setup: `\x1b[5;1H${"x".repeat(80)}` },
  ];
  const finals = ["S", "T", "L", "M", "I", "Z"].map((final) => ({ final }));
  const cases = screens.flatMap((s) => finals.map((f) => ({ ...s, ...f })));

  /** What a program can see of the screen: text, background, cursor and scrollback. */
  function state(term: Terminal): unknown {
    const buf = term.buffer.active;
    const rows = Array.from({ length: term.rows }, (_, y) => {
      const line = buf.getLine(buf.baseY + y);
      return [line?.translateToString(true), line?.getCell(0)?.getBgColor()];
    });
    return { type: buf.type, x: buf.cursorX, y: buf.cursorY, base: buf.baseY, rows };
  }

  const write = (term: Terminal, s: string) =>
    new Promise<void>((resolve) => {
      term.write(s, resolve);
    });
  const send = (r: XtermRenderer, s: string) =>
    new Promise<void>((resolve) => {
      r.write(encode(s), resolve);
    });

  /** A stock xterm with none of the renderer's handlers. */
  async function stock(output: string): Promise<unknown> {
    const term = new Terminal({ allowProposedApi: true, scrollback: 30_000 });
    await write(term, output);
    const seen = state(term);
    term.dispose();
    return seen;
  }

  async function rendered(...writes: string[]): Promise<unknown> {
    const r = new XtermRenderer({ fontSize: 12, isGlobalChord: () => false });
    for (const w of writes) await send(r, w);
    const seen = state(r.term);
    r.dispose();
    return seen;
  }

  // Past the bound, so these prove a stock xterm reaches the same screen on its own loop.
  it.each(cases)("$final at 2^31 - 1 on $screen matches a stock xterm's 200", async ({ setup, final }) => {
    const started = performance.now();
    const got = await rendered(setup, `\x1b[${String(MAX)}${final}`);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(got).toEqual(await stock(`${setup}\x1b[200${final}`));
  });

  it.each(cases)("$final with a normal count on $screen is what xterm does", async ({ setup, final }) => {
    for (const count of ["", "1", "3", "24"]) {
      const seq = `\x1b[${count}${final}`;
      expect(await rendered(setup, seq)).toEqual(await stock(`${setup}${seq}`));
    }
  });

  it("keeps parsing what follows in the same write", async () => {
    const seq = `A\x1b[${String(MAX)}S\x1b[5;1HB\x1b[${String(MAX)}I\x1b[${String(MAX)}Z\x1b[${String(MAX)}MC`;
    expect(await rendered(lines, seq)).toEqual(await stock(`${lines}A\x1b[200S\x1b[5;1HB\x1b[200I\x1b[200Z\x1b[200MC`));
  });

  it.each([
    { name: "split across two writes", writes: [`\x1b[${String(MAX).slice(0, 4)}`, `${String(MAX).slice(4)}S`] },
    { name: "a second param", writes: [`\x1b[${String(MAX)};5S`] },
    { name: "a sub parameter", writes: [`\x1b[${String(MAX)}:5S`] },
    { name: "the C1 form", writes: [`\x9b${String(MAX)}S`] },
    { name: "a C0 inside it", writes: [`\x1b[2147\x07483647S`] },
    { name: "one past the rows, split", writes: ["\x1b[2", "5S"] },
    { name: "one past the columns, split", writes: ["\x1b[8", "1I"] },
  ])("swallows $name, which the byte scan cannot see", async ({ writes }) => {
    const setup = `${lines}\x1b[10;5H`;
    const started = performance.now();
    const got = await rendered(setup, ...writes, "B");
    expect(performance.now() - started).toBeLessThan(1000);
    expect(got).toEqual(await stock(`${setup}B`));
  });

  it("lets a split count up to the grid through", async () => {
    const setup = `${lines}\x1b[10;5H`;
    expect(await rendered(setup, "\x1b[2", "4S")).toEqual(await stock(`${setup}\x1b[24S`));
    expect(await rendered(setup, "\x1b[8", "0I")).toEqual(await stock(`${setup}\x1b[80I`));
  });
});
