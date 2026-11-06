import type { IDisposable, Terminal } from "@xterm/xterm";

type Axis = "rows" | "cols";

/**
 * The CSI sequences xterm 6 runs once per count, with the side of the grid that bounds them.
 * Past that side a count changes nothing: every line of the scroll region is already blank, and
 * the cursor is already at the last tab stop. Each one is about nine minutes (lines) or 25 s
 * (tabs) of frozen page at 2^31 - 1. REP is the other, and is capped in xterm.ts.
 * See docs/notes/terminal-rep-cap.md.
 */
const COUNTED = new Map<string, Axis>([
  ["S", "rows"], // SU
  ["T", "rows"], // SD
  ["L", "rows"], // IL
  ["M", "rows"], // DL
  ["I", "cols"], // CHT
  ["Z", "cols"], // CBT
]);

const ESC = 0x1b;
const LEFT_BRACKET = 0x5b;
const ZERO = 0x30;
const NINE = 0x39;

const encoder = new TextEncoder();

/**
 * Rewrites `CSI Ps <final>` with a count past the grid to the grid's size, which does the same
 * thing. It has to happen here and not in a parser handler: a handler gets a copy of the params,
 * and term.write from inside one lands behind the rest of the chunk. Scanning bytes is safe
 * because ESC ends an OSC or DCS string, so `ESC [` is a CSI wherever it appears. Returns `data`
 * itself when there is nothing to rewrite.
 */
export function clampCounts(data: Uint8Array, grid: Pick<Terminal, Axis>): Uint8Array {
  const parts: Uint8Array[] = [];
  let kept = 0;
  for (let esc = data.indexOf(ESC); esc !== -1; esc = data.indexOf(ESC, esc + 1)) {
    if (data[esc + 1] !== LEFT_BRACKET) continue;
    const digits = esc + 2;
    let end = digits;
    let count = 0;
    for (let d = data[end]; d !== undefined && d >= ZERO && d <= NINE; d = data[++end]) count = count * 10 + d - ZERO;
    const axis = COUNTED.get(String.fromCharCode(data[end] ?? 0));
    if (axis === undefined || count <= grid[axis]) continue;
    parts.push(data.subarray(kept, digits), encoder.encode(String(grid[axis])));
    kept = end;
  }
  if (kept === 0) return data;
  parts.push(data.subarray(kept));
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/**
 * Swallows what clampCounts cannot see, so no count past the grid reaches xterm's loop. More
 * than one param or a sub parameter: Ghostty ignores those too. Split across two writes, with a
 * C0 inside it, or in its C1 form: the live view differs from the daemon until the next snapshot.
 */
export function swallowCountsPastGrid(term: Terminal): IDisposable[] {
  return [...COUNTED].map(([final, axis]) =>
    term.parser.registerCsiHandler({ final }, (params) => {
      const count = typeof params[0] === "number" ? params[0] : 1;
      return count > term[axis];
    }),
  );
}
