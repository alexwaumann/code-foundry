/**
 * In-thread find over the data (docs/notes/search-2-thread-find.md): the timeline is
 * virtualized and turns fold, so most of a thread's text is not in the DOM; matches are
 * counted from the items and painted only where their rows render.
 *
 * What it searches is what stays on screen when a turn folds, plus answered questions:
 * the user's messages (steers included; the text the bubble shows, not its tags), every
 * text of Claude's (as rendered: lib/markdownText; Ember's task links, drawn as pointer
 * lines, left out), and an AskUserQuestion's questions and
 * chosen answers (its expanded detail, where an answer counts once). Never tool calls,
 * their output, thinking, permission requests, notes, wakes or a subagent's items.
 *
 * Smart case: case-insensitive unless the query has an uppercase letter. A plain
 * substring: no regex, no whole word. Matches in one text do not overlap.
 */
import type { ThreadItemView } from "@/api/thread";
import { splitTaskLinks } from "./ember";
import { markdownText } from "./markdownText";
import { questionsOf } from "./threadRequest";
import { parseUserMessage } from "./userMessage";

/** Which row draws an item's searchable text. */
export type FindKind = "user" | "text" | "question";

/** An item's searchable text, as its row renders it. */
export interface FindDoc {
  itemId: string;
  kind: FindKind;
  text: string;
}

/** One match: the item, which of the item's matches it is, and where it is in the item's text. */
export interface FindMatch {
  itemId: string;
  nth: number;
  start: number;
  end: number;
}

/** A match's identity, stable while text streams in after it. */
export interface FindKey {
  itemId: string;
  nth: number;
}

/** The text a user message's bubble shows: its text pieces, without the tags (files, threads, skills, citations, attachments). */
export function userText(text: string, composerText: string, attachments: readonly string[]): string {
  return parseUserMessage(text, composerText, attachments)
    .map((p) => (p.kind === "text" ? p.text : ""))
    .join("");
}

/** An answered (or skipped) question's detail as it renders: each question, then its answer ("—" for none), a line each. */
export function questionText(inputJson: string, answers: Readonly<Record<string, string>>): string {
  return questionsOf(inputJson)
    .flatMap((q) => [q.question, answers[q.question] ?? "—"])
    .join("\n");
}

/**
 * Claude's (or Ember's) text as its row renders it: the markdown's text, without the task
 * links Ember's chat draws as pointer lines (lib/ember splitTaskLinks; only Ember writes
 * them), each markdown part a block of its own.
 */
export function answerText(text: string): string {
  return splitTaskLinks(text)
    .flatMap((p) => (p.kind === "md" ? [markdownText(p.text)] : []))
    .filter((t) => t !== "")
    .join("\n");
}

const docs = new WeakMap<ThreadItemView, FindDoc | null>();

/** An item's searchable text, or null for an item find does not search. Items keep their identity while unchanged, so each is read once. */
export function findDoc(it: ThreadItemView): FindDoc | null {
  const hit = docs.get(it);
  if (hit !== undefined) return hit;
  const doc = readDoc(it);
  docs.set(it, doc);
  return doc;
}

function readDoc(it: ThreadItemView): FindDoc | null {
  if (it.parentToolUseId !== "") return null;
  switch (it.kind) {
    case "user":
      return it.wake ? null : { itemId: it.id, kind: "user", text: userText(it.text, it.composerText, it.attachments) };
    case "text":
      return it.apiError ? null : { itemId: it.id, kind: "text", text: answerText(it.text) };
    case "question": {
      // A pending question docks in the composer, not in the timeline.
      if (it.request.state === "pending") return null;
      const text = questionText(it.request.inputJson, it.request.answers);
      return text === "" ? null : { itemId: it.id, kind: "question", text };
    }
    default:
      return null;
  }
}

/** Smart case: the query has an uppercase letter. */
export function caseSensitive(query: string): boolean {
  return /\p{Lu}/u.test(query);
}

/** Lower case with every UTF-16 unit kept in place (a letter whose lower case is longer stays as it is), so offsets hold. */
function fold(s: string): string {
  const lower = s.toLowerCase();
  if (lower.length === s.length) return lower;
  let out = "";
  for (const ch of s) {
    const l = ch.toLowerCase();
    out += l.length === ch.length ? l : ch;
  }
  return out;
}

/** Where `query` occurs in `text`, left to right, not overlapping (smart case). `folded`: the text in lower case, when the caller has it. */
export function matchOffsets(text: string, query: string, folded?: string): { start: number; end: number }[] {
  if (query === "" || text.length < query.length) return [];
  const sensitive = caseSensitive(query);
  const hay = sensitive ? text : (folded ?? fold(text));
  const needle = sensitive ? query : fold(query);
  const out: { start: number; end: number }[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) out.push({ start: i, end: i + needle.length });
  return out;
}

/** Each searchable text in lower case, kept with it (a streaming answer's changes with its item). */
const foldedDocs = new WeakMap<FindDoc, string>();

/** Every match in the items, in their order. */
export function findMatches(items: readonly ThreadItemView[], query: string): FindMatch[] {
  if (query === "") return [];
  const out: FindMatch[] = [];
  for (const it of items) {
    const doc = findDoc(it);
    if (!doc) continue;
    let lower = foldedDocs.get(doc);
    if (lower === undefined) {
      lower = fold(doc.text);
      foldedDocs.set(doc, lower);
    }
    matchOffsets(doc.text, query, lower).forEach((m, nth) => out.push({ itemId: doc.itemId, nth, ...m }));
  }
  return out;
}

/** A match's index in the list; -1 when it is not there. */
export function matchIndex(matches: readonly FindMatch[], key: FindKey | null): number {
  if (!key) return -1;
  return matches.findIndex((m) => m.itemId === key.itemId && m.nth === key.nth);
}

/**
 * The match a step lands on: the next (1) or previous (-1) one, wrapping. From no match
 * (-1), the first going forward and the last going back. -1 when there are none.
 */
export function stepIndex(count: number, from: number, dir: 1 | -1): number {
  if (count === 0) return -1;
  if (from < 0 || from >= count) return dir === 1 ? 0 : count - 1;
  return (from + dir + count) % count;
}

/**
 * The match to start on: the first in `itemId` when given and it has one; else the first
 * whose item is at or after `fromOrder` (the item order of the first row on screen); else
 * the last. -1 when there are none.
 */
export function startIndex(matches: readonly FindMatch[], order: ReadonlyMap<string, number>, opts: { itemId?: string; fromOrder?: number }): number {
  if (matches.length === 0) return -1;
  if (opts.itemId !== undefined) {
    const i = matches.findIndex((m) => m.itemId === opts.itemId);
    if (i >= 0) return i;
  }
  const from = opts.fromOrder ?? 0;
  const i = matches.findIndex((m) => (order.get(m.itemId) ?? 0) >= from);
  return i >= 0 ? i : matches.length - 1;
}

/** The count the find bar shows: "n of m", "0 of m" before a match is current. Empty for no query. */
export function countLabel(query: string, index: number, total: number): string {
  if (query === "") return "";
  return `${String(index >= 0 ? index + 1 : 0)} of ${String(total)}`;
}

/**
 * The row each match shows in (for the match map): its item's row, else the nearest row of
 * an item before it in the log (a folded question shows under its turn's last row on screen
 * before it), else the first row. `order`: the item ids in log order; `rowKeys`: the rows'
 * keys (an item's row has its id as key, as lib/threadTimeline and lib/ember build them).
 */
export function matchRows(order: readonly string[], rowKeys: readonly string[], matches: readonly FindMatch[]): number[] {
  const rowOf = new Map(rowKeys.map((k, i) => [k, i]));
  const at = new Map<string, number>();
  let last = 0;
  for (const id of order) {
    last = rowOf.get(id) ?? last;
    at.set(id, last);
  }
  return matches.map((m) => at.get(m.itemId) ?? 0);
}

/**
 * The log order of the first item a row stands for: an item's row (its id), a turn's
 * header (`h:<turn's first item>`), an explore group or thinking row (`g:`, `th:` and
 * their first item); undefined for a row of no item.
 */
export function rowOrder(key: string, order: ReadonlyMap<string, number>): number | undefined {
  return order.get(key) ?? order.get(key.replace(/^[a-z]+:/, ""));
}
