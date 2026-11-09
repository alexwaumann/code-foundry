/**
 * A log's SGR escapes (pluginsdk/ui Log.ANSI) as styled spans: the 16 colours (30-37,
 * 90-97 and their backgrounds), bold, dim, italic, underline and reset. 256-colour and
 * truecolor are mapped to the nearest of the 16, so every colour is the theme's
 * (`--terminal-ansi-N`, which follow light, dark and user themes). Every other escape
 * sequence (cursor moves, erases, titles, links, charsets) is dropped, never shown, as are
 * other control characters but tab; a carriage return inside a line keeps what follows it
 * (a progress line redrawn in place). The style carries from line to line, as in a
 * terminal. The scan is one pass over the text, and a line without ESC or a control
 * character costs a single test.
 */

/** A span's style; colours are palette indexes 0-15. */
export interface SgrStyle {
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
}

export interface AnsiSpan {
  text: string;
  /** null: unstyled. */
  style: SgrStyle | null;
}

export interface AnsiLine {
  /** The line without escapes: what Copy copies. */
  text: string;
  /** The line's spans; null when the whole line is unstyled (draw `text`). */
  spans: AnsiSpan[] | null;
}

/** The ESC and C0 control characters a line may hold (not tab or newline). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/;

/**
 * xterm's default 16 colours, which 256-colour and truecolor indexes are measured against
 * to pick the nearest palette entry (the theme then draws that entry its own way).
 */
const XTERM_16: readonly (readonly [number, number, number])[] = [
  [0, 0, 0],
  [205, 0, 0],
  [0, 205, 0],
  [205, 205, 0],
  [0, 0, 238],
  [205, 0, 205],
  [0, 205, 205],
  [229, 229, 229],
  [127, 127, 127],
  [255, 0, 0],
  [0, 255, 0],
  [255, 255, 0],
  [92, 92, 255],
  [255, 0, 255],
  [0, 255, 255],
  [255, 255, 255],
];

/** The palette entry nearest an RGB colour ("redmean" distance, close to what the eye sees). */
export function nearest16(r: number, g: number, b: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < XTERM_16.length; i++) {
    const c = XTERM_16[i] ?? [0, 0, 0];
    const rm = (r + c[0]) / 2;
    const dr = r - c[0];
    const dg = g - c[1];
    const db = b - c[2];
    const d = (2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

/** A 256-colour index as a palette entry: 0-15 as they are, the cube and the greys by nearest colour. */
export function index256(n: number): number | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return n;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return nearest16(v, v, v);
  }
  const c = n - 16;
  const level = (x: number) => (x === 0 ? 0 : 55 + x * 40);
  return nearest16(level(Math.floor(c / 36)), level(Math.floor(c / 6) % 6), level(c % 6));
}

/**
 * The extended colour at params[i] (38 or 48 already read): 5;n or 2;r;g;b, in ';' form
 * or as one ':' param. Returns the palette entry (undefined: dropped) and how many more
 * ';' params it used.
 */
function extended(params: readonly string[], i: number): [number | undefined, number] {
  const head = params[i] ?? "";
  if (head.includes(":")) {
    // 38:5:n, 38:2:r:g:b or 38:2:cs:r:g:b (a colour space id first).
    const sub = head.split(":");
    if (sub[1] === "5") return [index256(Number(sub[2])), 0];
    if (sub[1] === "2") {
      const rgb = sub.length >= 6 ? sub.slice(3, 6) : sub.slice(2, 5);
      return [rgbOf(rgb), 0];
    }
    return [undefined, 0];
  }
  const mode = params[i + 1];
  if (mode === "5") return [index256(Number(params[i + 2])), 2];
  if (mode === "2") return [rgbOf(params.slice(i + 2, i + 5)), 4];
  return [undefined, 0];
}

function rgbOf(parts: readonly string[]): number | undefined {
  if (parts.length < 3) return undefined;
  const [r, g, b] = parts.map((p) => (p === "" ? 0 : Number(p)));
  if (r === undefined || g === undefined || b === undefined || ![r, g, b].every((v) => Number.isInteger(v) && v >= 0 && v <= 255)) return undefined;
  return nearest16(r, g, b);
}

/** The style after one SGR sequence's parameters ("" is a reset); a cleared attribute is left out. */
export function applySgr(style: SgrStyle, paramText: string): SgrStyle {
  const params = paramText.split(";");
  let s: SgrStyle = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i] ?? "";
    const code = p === "" ? 0 : Number(p.split(":")[0]);
    switch (true) {
      case code === 0:
        s = {};
        break;
      case code === 1:
        s.bold = true;
        break;
      case code === 2:
        s.dim = true;
        break;
      case code === 3:
        s.italic = true;
        break;
      case code === 4:
        // 4:0 is "no underline"; 4:1-5 are its styles.
        if (p.split(":")[1] === "0") delete s.underline;
        else s.underline = true;
        break;
      case code === 21:
        s.underline = true;
        break;
      case code === 22:
        delete s.bold;
        delete s.dim;
        break;
      case code === 23:
        delete s.italic;
        break;
      case code === 24:
        delete s.underline;
        break;
      case code >= 30 && code <= 37:
        s.fg = code - 30;
        break;
      case code >= 90 && code <= 97:
        s.fg = code - 90 + 8;
        break;
      case code === 39:
        delete s.fg;
        break;
      case code >= 40 && code <= 47:
        s.bg = code - 40;
        break;
      case code >= 100 && code <= 107:
        s.bg = code - 100 + 8;
        break;
      case code === 49:
        delete s.bg;
        break;
      case code === 38:
      case code === 48: {
        const [c, used] = extended(params, i);
        if (code === 38) {
          if (c === undefined) delete s.fg;
          else s.fg = c;
        } else if (c === undefined) delete s.bg;
        else s.bg = c;
        i += used;
        break;
      }
      // Anything else (blink, inverse, hidden, strike, fonts, overline) is dropped.
    }
  }
  return s;
}

/** Whether a style draws as plain text. */
function plain(s: SgrStyle): boolean {
  return s.fg === undefined && s.bg === undefined && !s.bold && !s.dim && !s.italic && !s.underline;
}

/**
 * The length of the escape sequence at the start of s (s[i] is ESC); an unfinished one runs
 * to the end. Returns the length and, for an SGR (CSI … m with only digits, ';' and ':'),
 * its parameters. pluginsdk/ui's StripANSI drops the same sequences.
 */
function escapeAt(s: string, i: number): [number, string | null] {
  const next = s.charCodeAt(i + 1);
  if (Number.isNaN(next)) return [1, null];
  if (next === 0x5b) {
    // CSI: parameter and intermediate bytes 0x20-0x3f, a final byte 0x40-0x7e.
    for (let j = i + 2; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c >= 0x40 && c <= 0x7e) {
        const params = s.slice(i + 2, j);
        return [j + 1 - i, c === 0x6d && /^[\d;:]*$/.test(params) ? params : null];
      }
      if (c < 0x20 || c > 0x7e) return [j - i, null];
    }
    return [s.length - i, null];
  }
  if (next === 0x5d || next === 0x50 || next === 0x5f || next === 0x5e || next === 0x58) {
    // OSC, DCS, APC, PM, SOS: a string ended by BEL or ESC \.
    for (let j = i + 2; j < s.length; j++) {
      const c = s.charCodeAt(j);
      if (c === 0x07) return [j + 1 - i, null];
      if (c === 0x1b && s.charCodeAt(j + 1) === 0x5c) return [j + 2 - i, null];
    }
    return [s.length - i, null];
  }
  // nF: intermediates 0x20-0x2f, then a final byte (ESC ( B); else ESC and one byte.
  let j = i + 1;
  while (j < s.length && s.charCodeAt(j) >= 0x20 && s.charCodeAt(j) <= 0x2f) j++;
  if (j < s.length) j++;
  return [j - i, null];
}

/**
 * One line's spans from the style in force at its start; returns the line and the style at
 * its end.
 */
export function parseAnsiLine(line: string, start: SgrStyle): [AnsiLine, SgrStyle] {
  if (!CONTROL.test(line)) {
    return [{ text: line, spans: plain(start) ? null : [{ text: line, style: start }] }, start];
  }
  // A trailing CR is a CRLF line end, not a redraw.
  const src = line.endsWith("\r") ? line.slice(0, -1) : line;
  let spans: AnsiSpan[] = [];
  let style = start;
  let buf = "";
  const flush = () => {
    if (buf === "") return;
    const last = spans[spans.length - 1];
    if (last && last.style === style) last.text += buf;
    else spans.push({ text: buf, style });
    buf = "";
  };
  for (let i = 0; i < src.length; ) {
    const c = src.charCodeAt(i);
    if (c === 0x1b) {
      const [len, sgr] = escapeAt(src, i);
      if (sgr !== null) {
        const next = applySgr(style, sgr);
        flush();
        style = next;
      }
      i += len;
    } else if (c === 0x0d) {
      // A redraw: what follows replaces the line so far (its style still carries).
      buf = "";
      spans = [];
      i++;
    } else if ((c < 0x20 && c !== 0x09) || c === 0x7f) {
      i++;
    } else {
      // Plain text up to the next control character.
      let j = i + 1;
      while (j < src.length) {
        const d = src.charCodeAt(j);
        if ((d < 0x20 && d !== 0x09) || d === 0x7f) break;
        j++;
      }
      buf += src.slice(i, j);
      i = j;
    }
  }
  flush();
  const text = spans.map((sp) => sp.text).join("");
  const styled = spans.some((sp) => !plain(sp.style ?? {}));
  return [{ text, spans: styled ? spans.map((sp) => ({ text: sp.text, style: plain(sp.style ?? {}) ? null : sp.style })) : null }, style];
}

/** Every line's spans, the style carrying from each line to the next. */
export function parseAnsi(lines: readonly string[]): AnsiLine[] {
  const out: AnsiLine[] = new Array<AnsiLine>(lines.length);
  let style: SgrStyle = {};
  for (let i = 0; i < lines.length; i++) {
    const [line, next] = parseAnsiLine(lines[i] ?? "", style);
    out[i] = line;
    style = next;
  }
  return out;
}

/** The text without escapes or control characters (what Copy copies). */
export function stripAnsi(text: string): string {
  return text
    .split("\n")
    .map((l) => parseAnsiLine(l, {})[0].text)
    .join("\n");
}

/** A span's inline style: theme palette colours by CSS variable. */
export function sgrCss(s: SgrStyle): { color?: string; backgroundColor?: string } {
  return {
    ...(s.fg !== undefined && { color: `var(--terminal-ansi-${String(s.fg)})` }),
    ...(s.bg !== undefined && { backgroundColor: `var(--terminal-ansi-${String(s.bg)})` }),
  };
}
