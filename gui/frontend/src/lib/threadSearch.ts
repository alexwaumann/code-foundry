/**
 * The Find dialog's pure parts (search.open; docs/notes/search-4-find-dialog.md): the
 * query's terms as the daemon reads them, the list's rows from a search's answer, moving
 * the selection, matching a whole message again for the preview, and the query the
 * thread's find bar takes over.
 */
import type { SearchGroupView, SearchHitView, SearchNameView, SearchResultView, SearchSpeakerView, TextRange } from "@/api/threadSearch";
import { caseSensitive, matchOffsets } from "./threadFind";

/**
 * The query's terms, as the daemon splits them (internal/store/thread/search_match.go):
 * white space separates terms; `"a phrase"` is one term (an unclosed quote runs to the
 * end); control characters are dropped. Empty terms are dropped.
 */
export function searchTerms(query: string): string[] {
  const out: string[] = [];
  let b = "";
  let quoted = false;
  const flush = () => {
    const t = b.split(/\s+/).filter(Boolean).join(" ");
    if (t !== "") out.push(t);
    b = "";
  };
  for (const ch of query) {
    if (ch === '"') {
      flush();
      quoted = !quoted;
    } else if (/\s/u.test(ch)) {
      if (quoted) b += " ";
      else flush();
    } else if (!/\p{Cc}/u.test(ch)) b += ch;
  }
  flush();
  return out;
}

/**
 * The query the thread's find bar takes over on Enter (stores/threadFind openThreadFind).
 * The bar finds one plain substring, so a query of several terms hands over its longest
 * term (the first of equals): the whole query would match only where the terms happen to
 * be adjacent. One term (or one phrase) is handed over as it is, without its quotes.
 *
 * The bar's smart case follows the term alone, the daemon's the whole query. So when the
 * query is case-sensitive (a capital somewhere), only a term with a capital of its own is
 * handed over (the longest of those): a lower-case term would be searched without case in
 * the bar and land on a match the preview did not show.
 */
export function handoffQuery(query: string): string {
  const terms = searchTerms(query);
  const pool = caseSensitive(query) ? terms.filter(caseSensitive) : terms;
  let best = "";
  let bestLen = 0;
  for (const t of pool) {
    const n = codePoints(t);
    if (n > bestLen) [best, bestLen] = [t, n];
  }
  return best;
}

/**
 * Where the find bar finds the handed-over term in a text (the bar's own rule: smart case
 * over the term). What the preview's caption counts and its current match comes from.
 */
export function handoffMatches(text: string, query: string): TextRange[] {
  const term = handoffQuery(query);
  return term === "" ? [] : matchOffsets(text, term);
}

/** How many code points a string has (an emoji is one). */
function codePoints(s: string): number {
  return Array.from(s).length;
}

/** Where `term` occurs in `text`, exactly (a case-sensitive query: every term matches its case). */
function exactOffsets(text: string, term: string): TextRange[] {
  const out: TextRange[] = [];
  for (let i = text.indexOf(term); i >= 0; i = text.indexOf(term, i + term.length)) out.push({ start: i, end: i + term.length });
  return out;
}

/**
 * Every match of the query's terms in a whole text (the preview's message), left to right,
 * overlapping ones merged (as the daemon merges them). Smart case
 * over the whole query, as the daemon decides it: one capital letter anywhere makes every
 * term exact. The snippet's ranges point into the snippet only, so a whole message is
 * matched again here.
 */
export function queryMatches(text: string, query: string): TextRange[] {
  const sensitive = caseSensitive(query);
  const all = searchTerms(query).flatMap((t) => (sensitive ? exactOffsets(text, t) : matchOffsets(text, t)));
  all.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: TextRange[] = [];
  for (const m of all) {
    const last = out.at(-1);
    if (last && m.start <= last.end) last.end = Math.max(last.end, m.end);
    else out.push({ ...m });
  }
  return out;
}

/**
 * The match the thread's find bar makes current after the hand-off, among `matches` (the
 * text's queryMatches): the first match of the handed-over term (the bar takes the first
 * match in the item). -1 when the term is not among them.
 */
export function currentMatchIndex(text: string, matches: readonly TextRange[], query: string): number {
  const first = handoffMatches(text, query)[0];
  if (!first) return -1;
  return matches.findIndex((m) => m.start <= first.start && m.end > first.start);
}

/** A text cut into runs, the matched ones flagged (a name, a snippet). */
export interface TextRun {
  text: string;
  hit: boolean;
}

/** `text` cut at `ranges` (sorted, not overlapping, UTF-16). */
export function textRuns(text: string, ranges: readonly TextRange[]): TextRun[] {
  const out: TextRun[] = [];
  let at = 0;
  for (const r of ranges) {
    const start = Math.max(at, Math.min(r.start, text.length));
    const end = Math.min(r.end, text.length);
    if (end <= start) continue;
    if (start > at) out.push({ text: text.slice(at, start), hit: false });
    out.push({ text: text.slice(start, end), hit: true });
    at = end;
  }
  if (at < text.length || out.length === 0) out.push({ text: text.slice(at), hit: false });
  return out;
}

/** How much text a hit row keeps before its first match (UTF-16 units, about four words). */
export const SNIPPET_LEAD = 24;

/**
 * A snippet fitted to one narrow row: the daemon starts it up to 48 code points before the
 * first match, which a 440px row cuts off at its end, so the text before the first match is
 * cut to about `lead` units, at a word start, with "…" in front; the ranges move with it.
 */
export function fitSnippet(snippet: string, ranges: readonly TextRange[], lead: number = SNIPPET_LEAD): { text: string; ranges: TextRange[] } {
  const first = ranges[0]?.start ?? 0;
  if (first <= lead + 1) return { text: snippet, ranges: [...ranges] };
  let from = first - lead;
  // Forward to the start of a word (never inside an emoji, which follows no space), but never past the match.
  while (from < first && snippet[from - 1] !== " ") from++;
  const shift = 1 - from;
  return { text: `…${snippet.slice(from)}`, ranges: ranges.map((r) => ({ start: r.start + shift, end: r.end + shift })) };
}

/** A hit's speaker column: "You" for the user's message, else "Claude" (a question is Claude's too). */
export function speakerLabel(s: SearchSpeakerView): string {
  return s === "user" ? "You" : "Claude";
}

/** One row of the dialog's list. Only name and hit rows take the selection; the rest are drawn around them. */
export type SearchRow =
  | { kind: "section"; key: string; label: string }
  | { kind: "name"; key: string; name: SearchNameView }
  | { kind: "group"; key: string; group: SearchGroupView }
  | { kind: "hit"; key: string; hit: SearchHitView; group: SearchGroupView }
  | { kind: "more"; key: string; group: SearchGroupView; count: number }
  | { kind: "note"; key: string; text: string };

function plural(n: number, one: string, many: string): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The Messages section's heading: "Messages · 14 in 4 threads" (one thread: "6 in 1 thread"). */
export function messagesLabel(r: Pick<SearchResultView, "totalHits" | "totalThreads">): string {
  return `Messages · ${String(r.totalHits)} in ${plural(r.totalThreads, "thread", "threads")}`;
}

/**
 * The list's rows for an answer: "Threads" (the names that match), then "Messages · N in M
 * threads": per thread a header row, its hits, and "N more" when it has more than shown.
 * A quiet note last when only names were searched, or when the daemon read only the most
 * recent matches.
 */
export function searchRows(r: SearchResultView): SearchRow[] {
  const rows: SearchRow[] = [];
  if (r.threads.length > 0) {
    rows.push({ kind: "section", key: "sec:threads", label: "Threads" });
    for (const n of r.threads) rows.push({ kind: "name", key: `name:${n.threadId}`, name: n });
  }
  if (r.groups.length > 0) {
    rows.push({ kind: "section", key: "sec:messages", label: messagesLabel(r) });
    for (const g of r.groups) {
      rows.push({ kind: "group", key: `group:${g.threadId}`, group: g });
      for (const h of g.hits) rows.push({ kind: "hit", key: `hit:${g.threadId}:${h.itemId}`, hit: h, group: g });
      const more = g.totalHits - g.hits.length;
      if (more > 0) rows.push({ kind: "more", key: `more:${g.threadId}`, group: g, count: more });
    }
  }
  const shown = r.groups.length;
  if (r.namesOnly) rows.push({ kind: "note", key: "note:names", text: "Messages need a word of three letters or more." });
  else if (r.truncated) rows.push({ kind: "note", key: "note:truncated", text: "Many messages match: these are among the most recent. More words narrow it." });
  else if (shown < r.totalThreads) rows.push({ kind: "note", key: "note:limit", text: `${plural(r.totalThreads - shown, "more thread has", "more threads have")} matches. More words narrow it.` });
  return rows;
}

/** Whether a row takes the selection (arrow keys, Enter). */
export function selectable(row: SearchRow): row is Extract<SearchRow, { kind: "name" | "hit" }> {
  return row.kind === "name" || row.kind === "hit";
}

/** The first row that takes the selection; "" for none. */
export function firstSelectable(rows: readonly SearchRow[]): string {
  return rows.find(selectable)?.key ?? "";
}

/**
 * The selection after an arrow key: the next (dir 1) or previous (-1) row that takes it,
 * wrapping like the palette. A key not in the rows starts from the first (down) or the
 * last (up). "" when no row takes it.
 */
export function moveSelection(rows: readonly SearchRow[], key: string, dir: 1 | -1): string {
  const keys = rows.filter(selectable).map((r) => r.key);
  if (keys.length === 0) return "";
  const at = keys.indexOf(key);
  if (at < 0) return (dir === 1 ? keys[0] : keys.at(-1)) ?? "";
  return keys[(at + dir + keys.length) % keys.length] ?? "";
}

/**
 * The selection after a new answer: the same row when it is still listed, else the first.
 * A new query (not the same query answered again) always starts at the first.
 */
export function keepSelection(rows: readonly SearchRow[], key: string, sameQuery: boolean): string {
  if (sameQuery && rows.some((r) => r.key === key && selectable(r))) return key;
  return firstSelectable(rows);
}

/** Each row kind's height in the list: fixed, so the virtualizer's sizes are exact. */
export const SEARCH_ROW_HEIGHT: Readonly<Record<SearchRow["kind"], number>> = { section: 30, name: 32, group: 34, hit: 28, more: 26, note: 36 };

/** A "N more" row's text. */
export function moreLabel(n: number): string {
  return `${String(n)} more`;
}

/** A name row's time: "14:02" today, else the day ("Oct 19"), with the year when not this year; "" when not known. */
export function dayLabel(ms: number | null, now: number = Date.now()): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const today = new Date(now);
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toLocaleDateString([], d.getFullYear() === today.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
}
