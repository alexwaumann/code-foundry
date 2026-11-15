/**
 * Terminal output as styled text, one line at a time (the log preview, LogBody.tsx): SGR
 * colours and attributes become styles over the line's plain text, every other escape
 * sequence is dropped, and carriage returns, backspaces and erases collapse a line to what a
 * terminal would show at its end (a progress bar's last state). Pure: no DOM; `styleCss`
 * turns a style into CSS, the 16 colours as the terminal palette's variables
 * (src/terminal/theme.ts), so they follow the theme.
 */

/** A colour: a palette index (0–255), "#rrggbb" (true colour), or null for the default. */
export type AnsiColor = number | string | null;

export const BOLD = 1;
export const DIM = 2;
export const ITALIC = 4;
export const UNDERLINE = 8;
export const INVERSE = 16;
export const STRIKE = 32;

/** The pen: what the next character is written with. Never mutated; PLAIN is the one plain style. */
export interface AnsiStyle {
  readonly fg: AnsiColor;
  readonly bg: AnsiColor;
  /** BOLD | DIM | ITALIC | UNDERLINE | INVERSE | STRIKE. */
  readonly flags: number;
}

export const PLAIN: AnsiStyle = Object.freeze({ fg: null, bg: null, flags: 0 });

/** A stretch of a line's plain text in one style other than PLAIN: [from, to) in UTF-16 units. */
export interface AnsiRun {
  readonly from: number;
  readonly to: number;
  readonly style: AnsiStyle;
}

/** A line as a terminal leaves it: its text, the styled stretches, and the pen after it (the next line's start). */
export interface AnsiLine {
  readonly plain: string;
  readonly runs: readonly AnsiRun[];
  readonly end: AnsiStyle;
}

const ESC = "\u001b";

/** Whether a text has an escape sequence (the kind's sniff; one scan). */
export function hasAnsi(text: string): boolean {
  return text.includes(`${ESC}[`);
}

function make(fg: AnsiColor, bg: AnsiColor, flags: number): AnsiStyle {
  return fg === null && bg === null && flags === 0 ? PLAIN : { fg, bg, flags };
}

const byte = (s: string | undefined) => {
  const n = Number(s);
  return Number.isFinite(n) ? Math.min(255, Math.max(0, Math.trunc(n))) : 0;
};
const hex = (r: string | undefined, g: string | undefined, b: string | undefined) => `#${[r, g, b].map((v) => byte(v).toString(16).padStart(2, "0")).join("")}`;

/**
 * An extended colour (38/48) from its arguments, as `5;n` or `2;r;g;b` (after `;`) or the
 * colon form `5:n`, `2::r:g:b`, `2:r:g:b`. Returns the colour and how many arguments it used.
 */
function extended(args: readonly string[]): { color: AnsiColor; used: number } | null {
  if (args[0] === "5") return args.length >= 2 ? { color: byte(args[1]), used: 2 } : null;
  if (args[0] === "2") return args.length >= 4 ? { color: hex(args[1], args[2], args[3]), used: 4 } : null;
  return null;
}

/** The pen after an SGR sequence's parameters (`1;31`, `38;5;208`, `38:2::255:0:0`; empty is a reset). */
export function applySgr(style: AnsiStyle, params: string): AnsiStyle {
  let { fg, bg, flags } = style;
  const parts = params === "" ? ["0"] : params.split(";");
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    if (part.includes(":")) {
      const sub = part.split(":");
      const code = Number(sub[0]);
      if (code === 38 || code === 48) {
        // 2::r:g:b carries a colour space id; 2:r:g:b leaves it out.
        const args = sub[1] === "2" && sub.length >= 6 ? ["2", ...sub.slice(3)] : sub.slice(1);
        const c = extended(args);
        if (c && code === 38) fg = c.color;
        else if (c) bg = c.color;
      } else if (code === 4) flags = sub[1] === "0" ? flags & ~UNDERLINE : flags | UNDERLINE;
      continue;
    }
    const code = part === "" ? 0 : Number(part);
    if (code === 0) {
      fg = null;
      bg = null;
      flags = 0;
    } else if (code === 1) flags |= BOLD;
    else if (code === 2) flags |= DIM;
    else if (code === 3) flags |= ITALIC;
    else if (code === 4 || code === 21) flags |= UNDERLINE;
    else if (code === 7) flags |= INVERSE;
    else if (code === 9) flags |= STRIKE;
    else if (code === 22) flags &= ~(BOLD | DIM);
    else if (code === 23) flags &= ~ITALIC;
    else if (code === 24) flags &= ~UNDERLINE;
    else if (code === 27) flags &= ~INVERSE;
    else if (code === 29) flags &= ~STRIKE;
    else if (code >= 30 && code <= 37) fg = code - 30;
    else if (code === 39) fg = null;
    else if (code >= 40 && code <= 47) bg = code - 40;
    else if (code === 49) bg = null;
    else if (code >= 90 && code <= 97) fg = code - 90 + 8;
    else if (code >= 100 && code <= 107) bg = code - 100 + 8;
    else if (code === 38 || code === 48) {
      const c = extended(parts.slice(i + 1));
      if (!c) break;
      if (code === 38) fg = c.color;
      else bg = c.color;
      i += c.used;
    }
  }
  return fg === style.fg && bg === style.bg && flags === style.flags ? style : make(fg, bg, flags);
}

/** C0 controls other than tab and newline, and DEL: what needs more than copying. */
// eslint-disable-next-line no-control-regex
const SPECIAL = /[\u0000-\u0008\u000b-\u001f\u007f]/g;

/** Whether a line needs more than copying: a control other than tab (a CR, a backspace, NUL). */
export function hasControls(line: string): boolean {
  SPECIAL.lastIndex = 0;
  return SPECIAL.test(line);
}

/** What a control shows as: the Unicode control picture (␀ for NUL), or nothing (BEL, shift in/out). */
function picture(c: number): string {
  if (c === 0x07 || c === 0x0e || c === 0x0f) return "";
  return c === 0x7f ? "␡" : String.fromCharCode(0x2400 + c);
}

/**
 * A line being written, as a terminal's row: appending while the cursor is at the end (the
 * common case, a string and runs), and as cells once something moves the cursor back (a
 * carriage return, a backspace, a cursor move) or erases.
 */
class Row {
  private text = "";
  private runs: AnsiRun[] = [];
  private cells: { ch: string[]; st: AnsiStyle[] } | null = null;
  private cursor = 0;

  write(s: string, pen: AnsiStyle): void {
    if (s === "") return;
    if (!this.cells) {
      const from = this.text.length;
      this.text += s;
      if (pen !== PLAIN) {
        const last = this.runs[this.runs.length - 1];
        if (last?.style === pen && last.to === from) this.runs[this.runs.length - 1] = { from: last.from, to: this.text.length, style: pen };
        else this.runs.push({ from, to: this.text.length, style: pen });
      }
      this.cursor = this.text.length;
      return;
    }
    const { ch, st } = this.cells;
    for (const c of s) {
      while (ch.length < this.cursor) {
        ch.push(" ");
        st.push(PLAIN);
      }
      ch[this.cursor] = c;
      st[this.cursor] = pen;
      this.cursor++;
    }
  }

  /** From appending to cells, the cursor where it was (one cell per code point). */
  private toCells(): { ch: string[]; st: AnsiStyle[] } {
    if (this.cells) return this.cells;
    const ch: string[] = [];
    const st: AnsiStyle[] = [];
    let r = 0;
    let at = 0;
    for (const c of this.text) {
      while (r < this.runs.length && (this.runs[r]?.to ?? 0) <= at) r++;
      const run = this.runs[r];
      ch.push(c);
      st.push(run && run.from <= at ? run.style : PLAIN);
      at += c.length;
    }
    this.cells = { ch, st };
    this.cursor = ch.length;
    return this.cells;
  }

  /** Moves the cursor to a column (0-based, never below 0). */
  moveTo(col: number): void {
    this.toCells();
    this.cursor = Math.max(0, col);
  }

  /** The cursor's column (as cells: whatever asks is about to move it). */
  column(): number {
    this.toCells();
    return this.cursor;
  }

  /** Erase in line (CSI K): 0 from the cursor to the end, 1 from the start to the cursor, 2 all of it. */
  erase(mode: number): void {
    if (!this.cells && mode === 0) return;
    const cells = this.toCells();
    if (mode === 0 || mode === 2) {
      cells.ch.length = Math.min(cells.ch.length, mode === 2 ? 0 : this.cursor);
      cells.st.length = cells.ch.length;
    }
    if (mode === 1) {
      for (let i = 0; i <= this.cursor && i < cells.ch.length; i++) {
        cells.ch[i] = " ";
        cells.st[i] = PLAIN;
      }
    }
  }

  finish(end: AnsiStyle): AnsiLine {
    if (!this.cells) return { plain: this.text, runs: this.runs, end };
    const { ch, st } = this.cells;
    const runs: AnsiRun[] = [];
    let plain = "";
    for (let i = 0; i < ch.length; i++) {
      const from = plain.length;
      plain += ch[i] ?? " ";
      const style = st[i] ?? PLAIN;
      if (style === PLAIN) continue;
      const last = runs[runs.length - 1];
      if (last?.style === style && last.to === from) runs[runs.length - 1] = { from: last.from, to: plain.length, style };
      else runs.push({ from, to: plain.length, style });
    }
    return { plain, runs, end };
  }
}

const isParam = (c: number) => c >= 0x30 && c <= 0x3f;
const isIntermediate = (c: number) => c >= 0x20 && c <= 0x2f;
const isFinal = (c: number) => c >= 0x40 && c <= 0x7e;

/** Where a string sequence (OSC, DCS, APC, PM, SOS) that starts at `from` ends: after its BEL or ST, else the line's end. */
function stringEnd(raw: string, from: number): number {
  for (let j = from; j < raw.length; j++) {
    const c = raw.charCodeAt(j);
    if (c === 0x07) return j + 1;
    if (c === 0x1b && raw.charCodeAt(j + 1) === 0x5c) return j + 2;
  }
  return raw.length;
}

/**
 * One line of terminal output (no newline in it) written from the pen `start`: its plain
 * text, styled runs and the pen after it. A trailing "\r" (CRLF) is ignored. An escape cut
 * short at the line's end is dropped with whatever it had; a lone ESC is dropped.
 */
export function ansiLine(raw: string, start: AnsiStyle = PLAIN): AnsiLine {
  const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
  const row = new Row();
  let pen = start;
  let at = 0;
  SPECIAL.lastIndex = 0;
  for (let m = SPECIAL.exec(line); m; m = SPECIAL.exec(line)) {
    const i = m.index;
    if (i < at) continue;
    row.write(line.slice(at, i), pen);
    const c = line.charCodeAt(i);
    at = i + 1;
    if (c === 0x0d) row.moveTo(0);
    else if (c === 0x08) row.moveTo(row.column() - 1);
    else if (c !== 0x1b) row.write(picture(c), pen);
    else {
      const kind = line.charCodeAt(i + 1);
      if (kind === 0x5b) {
        // CSI: parameters, intermediates, one final byte.
        let j = i + 2;
        while (j < line.length && isParam(line.charCodeAt(j))) j++;
        const paramsEnd = j;
        while (j < line.length && isIntermediate(line.charCodeAt(j))) j++;
        const fin = line.charCodeAt(j);
        if (!isFinal(fin)) {
          // Cut short: drop what it had; the byte that broke it is text again.
          at = j;
        } else {
          at = j + 1;
          const params = line.slice(i + 2, paramsEnd);
          const priv = params !== "" && "<=>?".includes(params.charAt(0));
          const n = Number(params.split(";")[0] || "0");
          const f = String.fromCharCode(fin);
          if (priv || paramsEnd !== j) {
            // A private mode or a sequence with intermediates: nothing to show.
          } else if (f === "m") pen = applySgr(pen, params);
          else if (f === "K") row.erase(n);
          else if (f === "G") row.moveTo((n || 1) - 1);
          else if (f === "C") row.moveTo(row.column() + (n || 1));
          else if (f === "D") row.moveTo(row.column() - (n || 1));
        }
      } else if (kind === 0x5d || kind === 0x50 || kind === 0x58 || kind === 0x5e || kind === 0x5f) {
        // OSC (titles, hyperlinks), DCS, SOS, PM, APC: a string up to BEL or ST, dropped.
        at = stringEnd(line, i + 2);
      } else if (isIntermediate(kind)) {
        // ESC ( B and the like: intermediates, then a final.
        let j = i + 1;
        while (j < line.length && isIntermediate(line.charCodeAt(j))) j++;
        at = Math.min(line.length, j + 1);
      } else if (!Number.isNaN(kind)) at = i + 2;
    }
    SPECIAL.lastIndex = at;
  }
  row.write(line.slice(at), pen);
  return row.finish(pen);
}

/** The plain text of terminal output: every line as ansiLine leaves it, the pen carried across lines. */
export function stripAnsi(text: string): string {
  let pen = PLAIN;
  return text
    .split("\n")
    .map((l) => {
      const r = ansiLine(l, pen);
      pen = r.end;
      return r.plain;
    })
    .join("\n");
}

const CUBE = [0, 95, 135, 175, 215, 255];

/** A colour as CSS: the 16 as the terminal palette's variables, the 256's cube and greys, true colour as is. */
export function colorCss(c: number | string): string {
  if (typeof c === "string") return c;
  if (c < 16) return `var(--terminal-ansi-${String(c)})`;
  if (c >= 232) {
    const v = 8 + (c - 232) * 10;
    return `rgb(${String(v)}, ${String(v)}, ${String(v)})`;
  }
  const n = c - 16;
  return `rgb(${String(CUBE[Math.floor(n / 36)])}, ${String(CUBE[Math.floor(n / 6) % 6])}, ${String(CUBE[n % 6])})`;
}

/** CSS declarations for a style (camelCase keys, React's style prop). */
export interface AnsiCss {
  color?: string;
  backgroundColor?: string;
  fontWeight?: number;
  fontStyle?: string;
  textDecorationLine?: string;
  opacity?: number;
}

const cssCache = new WeakMap<AnsiStyle, AnsiCss>();

/** A style's CSS; inverse swaps the colours, the defaults being the text and the surface. */
export function styleCss(style: AnsiStyle): AnsiCss {
  const hit = cssCache.get(style);
  if (hit) return hit;
  let fg = style.fg === null ? undefined : colorCss(style.fg);
  let bg = style.bg === null ? undefined : colorCss(style.bg);
  if (style.flags & INVERSE) [fg, bg] = [bg ?? "var(--cf-surface)", fg ?? "var(--cf-text)"];
  const css: AnsiCss = {};
  if (fg !== undefined) css.color = fg;
  if (bg !== undefined) css.backgroundColor = bg;
  if (style.flags & BOLD) css.fontWeight = 700;
  if (style.flags & ITALIC) css.fontStyle = "italic";
  const lines = [style.flags & UNDERLINE ? "underline" : "", style.flags & STRIKE ? "line-through" : ""].filter(Boolean).join(" ");
  if (lines) css.textDecorationLine = lines;
  if (style.flags & DIM) css.opacity = 0.6;
  cssCache.set(style, css);
  return css;
}
