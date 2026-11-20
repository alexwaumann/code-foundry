/**
 * The finder's Text mode, the pure parts (file.find.text; docs/notes/file-search-5-text-mode.md):
 * when a query is sent, the list's rows from the streamed files, moving the selection, the
 * footer's status, the query's smart case and matching again in a file's lines for the
 * preview's paint, and what the File tab's find bar can take over on Enter.
 */
import type { TextFileView, TextLineView, TextQueryView, TextSummaryView } from "@/api/textSearch";
import type { TextRange } from "@/api/threadSearch";
import { absolutePath } from "./fileFinder";
import { caseSensitive as findBarCaseSensitive } from "./threadFind";
import { fitSnippet, textRuns, type TextRun } from "./threadSearch";

export { matchRanges, queryRegExp, smartCaseSensitive } from "./textQuery";

/**
 * The shortest query sent, in characters. One character matches nearly every line of a
 * codebase: the daemon stops at its 2,000 lines after the first chunk of files, so the list is
 * noise, and the first keystroke of every search would start a stream the second one cancels.
 */
export const TEXT_MIN_QUERY = 2;

/** How long typing pauses before the search goes out (a little longer than Files mode's 80 ms: each search starts ripgrep). */
export const TEXT_DEBOUNCE_MS = 120;

/** How long the selection rests on a match before its file is read for the preview (holding an arrow key reads nothing). */
export const TEXT_PREVIEW_DEBOUNCE_MS = 60;

/** Whether the typed text is long enough to search (spaces count: they are part of the text). */
export function queryReady(query: string): boolean {
  return Array.from(query).length >= TEXT_MIN_QUERY;
}

/** A search's identity: what was asked, of which checkouts. A new key is a new search. */
export function searchKey(q: TextQueryView, sources: string): string {
  return [q.query, q.matchCase ? "c" : "", q.wholeWord ? "w" : "", q.regex ? "r" : "", sources].join("\u0000");
}

/**
 * The query the File tab's find bar takes over on Enter, or null when the bar would find
 * something else: the bar searches one plain substring with smart case over it, so only a
 * literal, not whole-word, search whose case the bar would decide the same way
 * (lib/threadFind caseSensitive) goes over. A regex or whole-word search just opens at the line.
 */
export function findBarQuery(q: TextQueryView, caseSensitive: boolean): string | null {
  if (q.regex || q.wholeWord || q.query === "") return null;
  return findBarCaseSensitive(q.query) === caseSensitive ? q.query : null;
}

/** A file's matching-line count as the list shows it: "12", "999+". */
export function countLabel(f: Pick<TextFileView, "lineCount" | "lineCountCapped">): string {
  return f.lineCountCapped ? `${String(f.lineCount)}+` : String(f.lineCount);
}

/** The quiet note under a file whose rows stop before its count ("12 more in this file"); null when every line was sent. */
export function moreLabel(f: Pick<TextFileView, "lines" | "lineCount" | "lineCountCapped">): string | null {
  const left = f.lineCount - f.lines.length;
  if (left <= 0 && !f.lineCountCapped) return null;
  return f.lineCountCapped ? `${String(Math.max(left, 1))}+ more in this file` : `${String(left)} more in this file`;
}

/** One row of the results: a file's header, one of its matching lines, or its "N more" note. */
export type TextRow =
  | { kind: "file"; key: string; fileKey: string; file: TextFileView; name: string; dir: string; project: string | null; count: string }
  | { kind: "match"; key: string; fileKey: string; file: TextFileView; line: TextLineView; nth: number }
  | { kind: "more"; key: string; fileKey: string; file: TextFileView; text: string };

/** Each row kind's height: fixed, so the virtualizer's sizes are exact. */
export const TEXT_ROW_HEIGHT: Readonly<Record<TextRow["kind"], number>> = { file: 30, match: 24, more: 22 };

/**
 * The rows for the files streamed so far, in the daemon's order: per file its header, its
 * lines, then a note when it has more than were sent. `names` labels the project in a
 * thread with several checkouts (`multi`). A file listed twice (a checkout nested in
 * another) is kept once.
 */
export function textRows(files: readonly TextFileView[], names: Readonly<Record<string, string>>, multi: boolean): TextRow[] {
  const out: TextRow[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    const fileKey = absolutePath(file.checkout, file.path);
    if (seen.has(fileKey)) continue;
    seen.add(fileKey);
    const slash = file.path.lastIndexOf("/");
    out.push({
      kind: "file",
      key: `f:${fileKey}`,
      fileKey,
      file,
      name: file.path.slice(slash + 1),
      dir: slash > 0 ? file.path.slice(0, slash) : "",
      project: multi ? (names[file.projectId] ?? file.projectId) : null,
      count: countLabel(file),
    });
    file.lines.forEach((line, nth) => {
      out.push({ kind: "match", key: `m:${fileKey}:${String(line.line)}`, fileKey, file, line, nth });
    });
    const more = moreLabel(file);
    if (more !== null) out.push({ kind: "more", key: `n:${fileKey}`, fileKey, file, text: more });
  }
  return out;
}

export type MatchRow = Extract<TextRow, { kind: "match" }>;

export function isMatch(r: TextRow | undefined): r is MatchRow {
  return r?.kind === "match";
}

/** The first match row's key; "" when there is none. */
export function firstMatch(rows: readonly TextRow[]): string {
  return rows.find(isMatch)?.key ?? "";
}

/** The selection after an answer: the same match row when it is still listed and the answer is the same search's, else the first match. */
export function keepMatch(rows: readonly TextRow[], key: string, sameAnswer: boolean): string {
  return sameAnswer && rows.some((r) => r.key === key && isMatch(r)) ? key : firstMatch(rows);
}

/** The selection after an arrow key: the next (1) or previous (-1) match row, wrapping; from outside the rows, the first or the last. */
export function moveMatch(rows: readonly TextRow[], key: string, dir: 1 | -1): string {
  const keys = rows.filter(isMatch).map((r) => r.key);
  if (keys.length === 0) return "";
  const at = keys.indexOf(key);
  if (at < 0) return (dir === 1 ? keys[0] : keys.at(-1)) ?? "";
  return keys[(at + dir + keys.length) % keys.length] ?? "";
}

/** "match 2 of 3 in this file" (of "999+" when counted past the cap). */
export function matchPosition(row: MatchRow): string {
  return `match ${String(row.nth + 1)} of ${countLabel(row.file)} in this file`;
}

/** Thousands with a comma: 2,000. */
function num(n: number): string {
  return n.toLocaleString("en-US");
}

function plural(n: number, one: string, many: string): string {
  return `${num(n)} ${n === 1 ? one : many}`;
}

/** Why a search may miss files, in the finder's footer: the included ignored files were cut at fsx.MaxIncludedFiles. */
export const INCLUDED_CAPPED_NOTE = "searched the first 20,000 included files";

/**
 * The footer's status. "N matches in M files": N is the matching lines the files count (a
 * file's own count reaches past the 50 lines sent), with "+" when some went uncounted.
 * While the stream runs "Searching…" leads; the notes say why matches may be missing.
 */
export function statusText(files: readonly TextFileView[], summary: TextSummaryView | null): { text: string; notes: string[] } {
  const lines = files.reduce((n, f) => n + f.lineCount, 0);
  const more = files.some((f) => f.lineCountCapped) || (summary !== null && (summary.totalCapped || summary.timedOut));
  const count = files.length === 0 ? "" : `${num(lines)}${more ? "+" : ""} ${lines === 1 && !more ? "match" : "matches"} in ${plural(files.length, "file", "files")}`;
  if (summary === null) return { text: count === "" ? "Searching…" : `Searching… ${count}`, notes: [] };
  const notes: string[] = [];
  if (summary.totalCapped) notes.push("stopped at 2,000 lines");
  if (summary.timedOut) notes.push("stopped after 15 s");
  if (summary.includedCapped) notes.push(INCLUDED_CAPPED_NOTE);
  return { text: count === "" ? "No matches" : count, notes };
}

/** How much of a line a result row keeps before its first match (UTF-16 units, the code font is wide). */
export const LINE_LEAD = 20;

/**
 * A matching line as a result row draws it: its indentation dropped (unless a match is in
 * it), cut in front so the first match shows in the narrow row (lib/threadSearch fitSnippet),
 * an ellipsis wherever the daemon or the row cut the line; the matches as tinted runs.
 */
export function lineRuns(l: Pick<TextLineView, "text" | "ranges" | "cutStart" | "cutEnd">): { runs: TextRun[]; lead: boolean; trail: boolean } {
  let text = l.text;
  let ranges: TextRange[] = [...l.ranges];
  const indent = /^\s+/.exec(text)?.[0].length ?? 0;
  if (indent > 0 && !ranges.some((r) => r.start < indent)) {
    text = text.slice(indent);
    ranges = ranges.map((r) => ({ start: r.start - indent, end: r.end - indent }));
  }
  const fit = fitSnippet(text, ranges, LINE_LEAD);
  const fitted = fit.text !== text;
  return { runs: textRuns(fit.text, fit.ranges), lead: l.cutStart && !fitted, trail: l.cutEnd };
}
