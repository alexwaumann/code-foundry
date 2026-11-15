/**
 * The find in a File tab (docs/notes/file-find-in-file.md), as pure functions: where a query
 * occurs in a file's text, line by line, and which match a step or an edit lands on. Smart
 * case and plain substrings, as the thread's find (lib/threadFind). A query has no line
 * break (it is typed in a one-line field), so a match never crosses lines.
 */
import { matchOffsets } from "./threadFind";

/** A match: its zero-based line, its place among that line's matches, and its offsets in the line. */
export interface FileMatch {
  line: number;
  nth: number;
  start: number;
  end: number;
}

/** Which match is current: kept by line and place, so text changing elsewhere does not move it. */
export interface FileMatchKey {
  line: number;
  nth: number;
}

/** Past this many the count says "10000+" and the rest are not stepped through. */
export const MAX_FILE_MATCHES = 10_000;

export interface FileMatches {
  matches: FileMatch[];
  /** More matches than MAX_FILE_MATCHES. */
  capped: boolean;
}

/**
 * A line longer than this paints no matches. WebKit misdraws a Custom Highlight on a text
 * run of about 10,000 characters or more (the run fills with the highlight and its text
 * goes), and each range costs about the line's length on every frame: a minified file's
 * one line with thousands of matches froze the window for minutes.
 */
export const LONG_LINE = 5_000;
/** At most this many matches are painted on one line: the nearest the current one. */
export const MAX_LINE_PAINTS = 200;

/**
 * The indices of a line's `count` matches to paint (the File tab's find, the Text mode's
 * preview), `current` the current match's (-1 when it is not on this line): at most
 * MAX_LINE_PAINTS around the current one (the first ones without it), none on a line of
 * `lineLength` over LONG_LINE.
 */
export function paintedMatches(lineLength: number, count: number, current: number): number[] {
  if (lineLength > LONG_LINE) return [];
  const n = Math.min(count, MAX_LINE_PAINTS);
  const from = current < 0 ? 0 : Math.max(0, Math.min(current - (n >> 1), count - n));
  return Array.from({ length: n }, (_, i) => from + i);
}

/** Line breaks as @pierre/diffs splits a document (editor.js: `/\r\n|\r|\n/`). */
const BREAK = /\r\n|\r|\n/g;

/** Where each line starts in `text`, and how long its break is (0 for the last line). */
function lineStarts(text: string): number[] {
  const starts = [0];
  BREAK.lastIndex = 0;
  for (let m = BREAK.exec(text); m; m = BREAK.exec(text)) starts.push(m.index + m[0].length);
  return starts;
}

/** The index of the last start at or before `offset`. */
function lineAt(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Every match of `query` in `text`, in order, at most MAX_FILE_MATCHES of them. */
export function findInFile(text: string, query: string, max = MAX_FILE_MATCHES): FileMatches {
  if (query === "" || /[\r\n]/.test(query)) return { matches: [], capped: false };
  const all = matchOffsets(text, query);
  const capped = all.length > max;
  const starts = lineStarts(text);
  const matches: FileMatch[] = [];
  let line = -1;
  let nth = 0;
  for (const m of capped ? all.slice(0, max) : all) {
    const at = lineAt(starts, m.start);
    nth = at === line ? nth + 1 : 0;
    line = at;
    const from = starts[at] ?? 0;
    matches.push({ line: at, nth, start: m.start - from, end: m.end - from });
  }
  return { matches, capped };
}

/** A match's index; -1 when the key names none. */
export function fileMatchIndex(matches: readonly FileMatch[], key: FileMatchKey | null): number {
  if (!key) return -1;
  return matches.findIndex((m) => m.line === key.line && m.nth === key.nth);
}

/** The first match on or after `line` and, on that line, at or after `column`; else the first (wrapping). -1 for none. */
export function firstFrom(matches: readonly FileMatch[], line: number, column = 0): number {
  if (matches.length === 0) return -1;
  const i = matches.findIndex((m) => m.line > line || (m.line === line && m.start >= column));
  return i >= 0 ? i : 0;
}

/** The match nearest to where `key`'s was (its line and column): the text changed under it. -1 for none. */
export function nearestMatch(matches: readonly FileMatch[], line: number, column: number): number {
  let best = -1;
  let bestD = Infinity;
  matches.forEach((m, i) => {
    const d = Math.abs(m.line - line) * 1e6 + Math.abs(m.start - column);
    if (d < bestD) {
      best = i;
      bestD = d;
    }
  });
  return best;
}

/** What the find knows when its matches are counted again. */
export interface PickInput {
  /** The first count since the body mounted (the bar opening, or a tab coming back to an open bar). */
  first: boolean;
  /** The query was edited. */
  queryChanged: boolean;
  /** The text changed under the same query (an edit, a re-read, a page loading). */
  textChanged: boolean;
  matches: readonly FileMatch[];
  /** The current match's key. */
  current: FileMatchKey | null;
  /** The current match as it was in the last count. */
  was: FileMatch | undefined;
  /** Where the last current match was, kept through a query with none. */
  anchor: { line: number; start: number } | null;
  /** The first line on screen. */
  top: () => number;
}

/**
 * The match to make current after a count, and whether to bring it into view; null to
 * leave it. Opening goes from the top of the view (a tab coming back keeps its match, in
 * place); typing goes on from the match that was current (or where it was, through a query
 * with none), as a browser's find does, and brings it into view; an edit of the text keeps
 * the nearest match, in place; matches arriving after none take the first from the top, in
 * place. -1 with no matches.
 */
export function pickCurrent(p: PickInput): { index: number; reveal: boolean } | null {
  const { matches } = p;
  if (matches.length === 0) return { index: -1, reveal: false };
  if (p.first) {
    const at = fileMatchIndex(matches, p.current);
    return at >= 0 ? { index: at, reveal: false } : { index: firstFrom(matches, p.top()), reveal: true };
  }
  if (p.queryChanged) {
    const from = p.was ?? p.anchor;
    return { index: from ? firstFrom(matches, from.line, from.start) : firstFrom(matches, p.top()), reveal: true };
  }
  if (p.textChanged) {
    const from = p.was ?? p.anchor;
    return { index: from ? nearestMatch(matches, from.line, from.start) : firstFrom(matches, p.top()), reveal: false };
  }
  return null;
}

/** "4 of 9", "4 of 10000+", "0 of 9" before a match is current; empty for no query. */
export function fileCountLabel(query: string, index: number, total: number, capped: boolean): string {
  if (query === "") return "";
  return `${String(index >= 0 ? index + 1 : 0)} of ${String(total)}${capped ? "+" : ""}`;
}
