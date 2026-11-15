/**
 * A read parsed once for the log preview (LogBody.tsx): where each line starts, its level
 * (a continuation takes the level of the entry above), the pen each line starts with when
 * the text has escapes, and the counts the level filter shows. A row's layout (viewLine)
 * is worked out only when the row is drawn, and kept. Pure.
 */
import type { FileReadView } from "@/api/files";
import { ansiLine, hasAnsi, hasControls, PLAIN, stripAnsi, type AnsiRun, type AnsiStyle } from "./ansi";
import { detectLevel, ERROR, FATAL, startsEntry, timeAt, viewLine, type Level, type LogLineView } from "./logLine";

export interface LogDoc {
  readonly text: string;
  /** The byte of the file `text` starts at (a tail read's offset). */
  readonly offset: number;
  /** Lines in the text (a final newline ends the last one). */
  readonly lines: number;
  /** Line i is text[starts[i], end) with the newline (and a CR before it) left out. */
  readonly starts: Uint32Array;
  /** Timestamps, levels and fields are looked for (a `.log`); otherwise terminal output only. */
  readonly structured: boolean;
  /** Each line's level, its own or the entry's it continues; all 0 when not structured. */
  readonly levels: Uint8Array;
  /** Whether line i says its level itself (the level column shows it). */
  readonly own: Uint8Array;
  /** Lines per level (index Level), as the filter shows them: a continuation counts with its entry. */
  readonly counts: readonly number[];
  /** Some line said a level: the filter shows. */
  readonly leveled: boolean;
  /** The widest short timestamp, in characters: the time column (0: none). */
  readonly timeCols: number;
  /** The text has escape sequences. */
  readonly ansi: boolean;
  /** The pen each line starts with (escapes carry across lines until a reset); null without escapes. */
  readonly pens: readonly AnsiStyle[] | null;
  /** The longest line's length after escapes, in characters (the unwrapped width). */
  readonly cols: number;
}

/** Where line i ends (before its newline and a CR before that). */
export function lineEnd(doc: Pick<LogDoc, "text" | "starts" | "lines">, i: number): number {
  let end = i + 1 < doc.lines ? (doc.starts[i + 1] ?? 0) - 1 : doc.text.endsWith("\n") ? doc.text.length - 1 : doc.text.length;
  if (end > (doc.starts[i] ?? 0) && doc.text.charCodeAt(end - 1) === 13) end--;
  return end;
}

/** Line starts: a final newline ends the last line rather than starting another; "" has none. */
function lineStarts(text: string): Uint32Array {
  let n = text === "" ? 0 : 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  if (text.endsWith("\n")) n--;
  const starts = new Uint32Array(n);
  let k = 1;
  for (let i = text.indexOf("\n"); i >= 0 && k < n; i = text.indexOf("\n", i + 1)) starts[k++] = i + 1;
  return starts;
}

/** Parses a read: `structured` for a `.log` (levels and timestamps), else terminal output only. */
export function parseLog(text: string, structured: boolean, offset = 0): LogDoc {
  const starts = lineStarts(text);
  const lines = starts.length;
  const levels = new Uint8Array(lines);
  const own = new Uint8Array(lines);
  const counts = [0, 0, 0, 0, 0, 0, 0];
  const ansi = hasAnsi(text);
  const pens: AnsiStyle[] | null = ansi ? new Array<AnsiStyle>(lines) : null;
  let pen = PLAIN;
  let cols = 0;
  let timeCols = 0;
  let leveled = false;
  let above: Level = 0;
  const doc = { text, starts, lines };
  for (let i = 0; i < lines; i++) {
    const start = starts[i] ?? 0;
    const raw = text.slice(start, lineEnd(doc, i));
    let line = raw;
    if (pens) {
      pens[i] = pen;
      if (raw.includes("\u001b") || raw.includes("\r") || raw.includes("\b")) {
        const r = ansiLine(raw, pen);
        line = r.plain;
        pen = r.end;
      }
    } else if (raw.includes("\r")) line = ansiLine(raw).plain;
    if (line.length > cols) cols = line.length;
    if (!structured) continue;
    const said = detectLevel(line);
    let level: Level = said;
    if (said) {
      own[i] = 1;
      leveled = true;
    }
    const t = timeAt(line);
    if (t && t.short.length > timeCols) timeCols = t.short.length;
    // A line that says no level continues the entry above unless it starts one itself.
    if (!said) level = startsEntry(line) && !/^\s/.test(line) ? 0 : above;
    levels[i] = level;
    counts[level] = (counts[level] ?? 0) + 1;
    above = level;
  }
  return { text, offset, lines, starts, structured, levels, own, counts, leveled, timeCols, ansi, pens, cols };
}

const docs = new WeakMap<FileReadView, Map<boolean, LogDoc>>();

/** A read's parse, made once per read and kind (the kind's meta, its copy and the body share it). */
export function docOf(file: FileReadView, structured: boolean): LogDoc {
  let byKind = docs.get(file);
  if (!byKind) {
    byKind = new Map();
    docs.set(file, byKind);
  }
  let doc = byKind.get(structured);
  if (!doc) {
    doc = parseLog(file.text ?? "", structured, file.offset ?? 0);
    byKind.set(structured, doc);
  }
  return doc;
}

/** A row: the line laid out (logLine.ts viewLine) and its ANSI runs when it is the line as written. */
export interface LogRow extends LogLineView {
  readonly runs: readonly AnsiRun[];
}

const rowCache = new WeakMap<LogDoc, Map<number, LogRow>>();
/** Rows kept per doc: about a screenful many times over, so scrolling back does not lay them out again. */
const ROW_CACHE = 4000;

/** Line i laid out for its row, once. */
export function rowOf(doc: LogDoc, i: number): LogRow {
  let cache = rowCache.get(doc);
  if (!cache) {
    cache = new Map();
    rowCache.set(doc, cache);
  }
  const hit = cache.get(i);
  if (hit) return hit;
  const raw = doc.text.slice(doc.starts[i] ?? 0, lineEnd(doc, i));
  const a = doc.pens ? ansiLine(raw, doc.pens[i] ?? PLAIN) : hasControls(raw) ? ansiLine(raw) : null;
  const view = viewLine(a ? a.plain : raw, doc.structured);
  const row: LogRow = { ...view, runs: view.asWritten && a ? a.runs : [] };
  if (cache.size >= ROW_CACHE) cache.clear();
  cache.set(i, row);
  return row;
}

/** Whether line i is shown under a filter: "all", or a level's lines (Error takes FATAL too). */
export function inFilter(doc: LogDoc, i: number, filter: Level | "all"): boolean {
  if (filter === "all") return true;
  const l = doc.levels[i] ?? 0;
  return filter === ERROR ? l === ERROR || l === FATAL : l === filter;
}

/** The lines a filter shows, in order; null for "all" (every line). */
export function filterRows(doc: LogDoc, filter: Level | "all"): Uint32Array | null {
  if (filter === "all") return null;
  let n = 0;
  for (let i = 0; i < doc.lines; i++) if (inFilter(doc, i, filter)) n++;
  const rows = new Uint32Array(n);
  let k = 0;
  for (let i = 0; i < doc.lines; i++) if (inFilter(doc, i, filter)) rows[k++] = i;
  return rows;
}

/** What a filter's chip counts. */
export function filterCount(doc: LogDoc, filter: Level | "all"): number {
  if (filter === "all") return doc.lines;
  return filter === ERROR ? (doc.counts[ERROR] ?? 0) + (doc.counts[FATAL] ?? 0) : (doc.counts[filter] ?? 0);
}

/** Copy contents in the rendered view: the text as shown, escape sequences gone and overwrites collapsed. */
export function plainText(text: string): string {
  return hasAnsi(text) || text.includes("\r") || text.includes("\b") ? stripAnsi(text) : text;
}

/** UTF-8 bytes of text[from, to). */
export function utf8Length(text: string, from: number, to: number): number {
  let n = 0;
  for (let i = from; i < to; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80) n += 1;
    else if (c < 0x800) n += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < to) {
      n += 4;
      i++;
    } else n += 3;
  }
  return n;
}

/**
 * The line of `next` that is line `line` of `prev`, by where it sits in the file (the
 * read's offset plus the bytes before it): a tail read that moved on as the file grew
 * still finds the line the reader was on. A line no longer read gives the first.
 */
export function sameLine(prev: LogDoc, line: number, next: LogDoc): number {
  if (next.lines === 0) return 0;
  const at = prev.offset + utf8Length(prev.text, 0, prev.starts[line] ?? 0);
  let want = at - next.offset;
  if (want <= 0) return 0;
  // Walk next's lines by their byte lengths until the one that starts at or past it.
  for (let i = 0; i < next.lines; i++) {
    const start = next.starts[i] ?? 0;
    const end = i + 1 < next.lines ? (next.starts[i + 1] ?? 0) : next.text.length;
    const len = utf8Length(next.text, start, end);
    if (want < len) return i;
    want -= len;
    if (want === 0) return Math.min(i + 1, next.lines - 1);
  }
  return next.lines - 1;
}
