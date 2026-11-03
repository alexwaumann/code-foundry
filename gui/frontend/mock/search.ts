/**
 * ThreadService.Search (docs/notes/search-3-index.md) and ListItems' pages over the
 * world's threads, for the Find dialog (docs/notes/search-4-find-dialog.md). The daemon's
 * rules without an index: the threads the sidebar can show (no plugin's, archived and
 * snoozed included), their own user messages (wakes left out), Claude's texts and answered
 * questions. Every term must occur; smart case over the whole query; a query of terms
 * under three characters searches names only. Hits per thread: the newest per_thread, in
 * conversation order; groups by their newest hit. Ranges in code points. Snippets are cut
 * by the daemon's rule (snippetOf).
 *
 * Known simplifications (the daemon's rules in internal/store/thread/search*.go):
 * - no hit tiers: a whole-word match does not rank above one inside a word;
 * - lower case is JavaScript's toLowerCase, not Go's per-rune unicode.ToLower (`İ` differs);
 * - API-error texts are indexed like any of Claude's texts;
 * - a fork's copied items are not deduped against its parent's.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { MessageOrigin, ThreadItemRole, ThreadRequestState, type ListThreadItemsRequest, type ThreadItemSchema } from "../src/gen/codefoundry/v1/thread_pb";
import { SearchSpeaker, type SearchThreadsRequest, type SearchThreadsResponseSchema } from "../src/gen/codefoundry/v1/thread_search_pb";
import { CommandError } from "./errors";
import { promptText } from "./prompts";
import type { World } from "./world";

type ItemInit = MessageInitShape<typeof ThreadItemSchema>;
type SearchResponseInit = MessageInitShape<typeof SearchThreadsResponseSchema>;
type Range = { start: number; end: number };

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 500;
const DEFAULT_PER_THREAD = 5;
const SNIPPET = 160;
const BEFORE = 48;

/** The daemon's splitTerms: white space separates, "a phrase" is one term, control characters dropped. */
function splitTerms(q: string): string[] {
  const out: string[] = [];
  let b = "";
  let quoted = false;
  const flush = () => {
    const t = b.split(/\s+/).filter(Boolean).join(" ");
    if (t) out.push(t);
    b = "";
  };
  for (const ch of q) {
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

/** Every term's matches in text (code points, sorted, overlaps merged), or null when a term is missing. */
function matchAll(text: string, terms: readonly string[], sensitive: boolean): Range[] | null {
  const hay = Array.from(sensitive ? text : text.toLowerCase());
  const all: Range[] = [];
  for (const term of terms) {
    const needle = Array.from(sensitive ? term : term.toLowerCase());
    let found = false;
    for (let i = 0; i + needle.length <= hay.length; i++) {
      if (needle.every((c, k) => hay[i + k] === c)) {
        all.push({ start: i, end: i + needle.length });
        found = true;
        i += needle.length - 1;
      }
    }
    if (!found) return null;
  }
  all.sort((a, b) => a.start - b.start);
  const out: Range[] = [];
  for (const m of all) {
    const last = out.at(-1);
    if (last && m.start <= last.end) last.end = Math.max(last.end, m.end);
    else out.push({ ...m });
  }
  return out;
}

/** One line: white space runs as one space. */
function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** The item's indexed text and speaker, or null for a kind the index leaves out. */
function indexed(it: ItemInit, name: (id: string) => string | undefined): { text: string; speaker: SearchSpeaker } | null {
  if (it.parentToolUseId) return null;
  const p = it.payload;
  switch (p?.case) {
    case "userMessage":
      if ((p.value.origin ?? MessageOrigin.USER) === MessageOrigin.WAKE) return null;
      return { text: oneLine(promptText(p.value.text ?? "", p.value.composerText ?? "", name).text), speaker: SearchSpeaker.USER };
    case "assistantText":
      return { text: oneLine(p.value.text ?? ""), speaker: SearchSpeaker.ASSISTANT };
    case "question": {
      if (p.value.state === ThreadRequestState.PENDING) return null;
      let qs: { question?: string }[];
      try {
        qs = ((JSON.parse(p.value.inputJson ?? "{}") as { questions?: { question?: string }[] }).questions ?? []).filter((q) => typeof q.question === "string");
      } catch {
        qs = [];
      }
      const answers = p.value.answers ?? {};
      const lines = qs.flatMap((q) => [q.question ?? "", answers[q.question ?? ""] ?? ""]).filter(Boolean);
      return lines.length > 0 ? { text: oneLine(lines.join("\n")), speaker: SearchSpeaker.QUESTION } : null;
    }
    default:
      return null;
  }
}

/**
 * The daemon's cutSnippet (internal/store/thread/search_match.go): a text of at most
 * SNIPPET code points whole; else up to BEFORE before the first match, moved on to the
 * next word while that keeps the match; SNIPPET long, the start moved back when the end
 * runs out (so near the text's end the match can sit up to about 150 in, what the GUI's
 * fitSnippet exists for); the end back to the last space after the first match. "…" where
 * cut (one code point); the ranges inside it, shifted onto it.
 */
export function snippetOf(text: string, ranges: readonly Range[]): { snippet: string; ranges: Range[] } {
  const r = Array.from(text);
  const first = ranges[0];
  if (r.length <= SNIPPET || !first) return { snippet: text, ranges: [...ranges] };
  let start = Math.max(0, first.start - BEFORE);
  if (start > 0) {
    const i = r.slice(start, first.start).indexOf(" ");
    if (i >= 0) start += i + 1;
  }
  let end = Math.min(r.length, start + SNIPPET);
  if (end - start < SNIPPET) start = Math.max(0, end - SNIPPET);
  if (end < r.length) {
    const i = r.slice(first.end, end).lastIndexOf(" ");
    if (i >= 0) end = first.end + i;
  }
  const off = start > 0 ? 1 : 0;
  return {
    snippet: (start > 0 ? "…" : "") + r.slice(start, end).join("") + (end < r.length ? "…" : ""),
    ranges: ranges.filter((m) => m.start >= start && m.end <= end).map((m) => ({ start: m.start - start + off, end: m.end - start + off })),
  };
}

function ms(it: ItemInit): number {
  return it.createdAt ? timestampDate(it.createdAt as Parameters<typeof timestampDate>[0]).getTime() : 0;
}

/** ThreadService.Search over the world. */
export function searchThreads(world: World, req: SearchThreadsRequest): SearchResponseInit {
  const terms = splitTerms(req.query);
  if (terms.length === 0) throw new CommandError("invalid", "the query has no term");
  const sensitive = /\p{Lu}/u.test(req.query);
  const namesOnly = terms.every((t) => Array.from(t).length < 3);
  const limit = Math.min(req.limit > 0 ? req.limit : DEFAULT_LIMIT, MAX_LIMIT);
  const perThread = Math.min(req.perThread > 0 ? req.perThread : DEFAULT_PER_THREAD, limit);
  const name = (id: string) => world.threads.get(id)?.name;
  const scope = [...world.threads.values()].filter((t) => !t.owner && world.inSidebar(t));

  const threads = scope
    .flatMap((t) => {
      const ranges = matchAll(t.name, terms, sensitive);
      return ranges ? [{ t, ranges }] : [];
    })
    .sort((a, b) => b.t.lastActivityAt.getTime() - a.t.lastActivityAt.getTime())
    .slice(0, limit)
    .map(({ t, ranges }) => ({ threadId: t.id, name: t.name, ranges, archived: t.archivedAt !== null, lastActivityAt: timestampFromDate(t.lastActivityAt) }));

  let totalHits = 0;
  const groups: { threadId: string; threadName: string; archived: boolean; totalHits: number; newest: number; hits: NonNullable<SearchResponseInit["groups"]>[number]["hits"] }[] = [];
  if (!namesOnly) {
    for (const t of scope) {
      const found: { it: ItemInit; text: string; speaker: SearchSpeaker; ranges: Range[] }[] = [];
      for (const it of world.logs.snapshotValue(t.id).items) {
        const doc = indexed(it, name);
        if (!doc) continue;
        const ranges = matchAll(doc.text, terms, sensitive);
        if (ranges) found.push({ it, ...doc, ranges });
      }
      if (found.length === 0) continue;
      totalHits += found.length;
      const best = [...found].sort((a, b) => ms(b.it) - ms(a.it)).slice(0, perThread);
      best.sort((a, b) => Number(a.it.ordinal ?? 0) - Number(b.it.ordinal ?? 0));
      groups.push({
        threadId: t.id,
        threadName: t.name,
        archived: t.archivedAt !== null,
        totalHits: found.length,
        newest: Math.max(...found.map((f) => ms(f.it))),
        hits: best.map((f) => ({ threadId: t.id, itemId: f.it.id ?? "", ordinal: BigInt(f.it.ordinal ?? 0), speaker: f.speaker, createdAt: f.it.createdAt, ...snippetOf(f.text, f.ranges) })),
      });
    }
  }
  groups.sort((a, b) => b.newest - a.newest);
  // At most `limit` hits in all.
  let left = limit;
  const shown = groups.flatMap(({ newest: _newest, ...g }) => {
    if (left <= 0) return [];
    const hits = (g.hits ?? []).slice(0, left);
    left -= hits.length;
    return [{ ...g, hits }];
  });
  return { threads, groups: shown, caseSensitive: sensitive, namesOnly, totalHits, totalThreads: groups.length, truncated: false };
}

/** Whether an item is of a ListItems role (the daemon's roleMatches). */
function roleMatches(role: ThreadItemRole, it: ItemInit): boolean {
  const p = it.payload;
  const wake = p?.case === "userMessage" && (p.value.origin ?? MessageOrigin.USER) === MessageOrigin.WAKE;
  switch (role) {
    case ThreadItemRole.USER:
      return p?.case === "userMessage" && !wake;
    case ThreadItemRole.WAKE:
      return wake;
    case ThreadItemRole.ASSISTANT:
      return p?.case === "assistantText";
    case ThreadItemRole.TOOL:
      return p?.case === "toolCall" || p?.case === "permission" || p?.case === "question";
    case ThreadItemRole.NOTE:
      return p?.case === "note";
    default:
      return true;
  }
}

/** ListItems: the snapshot, or with a query a page (the daemon's pageItems: since an id or ordinal, the last N, a role). */
export function listItems(world: World, req: ListThreadItemsRequest) {
  const snap = world.logs.snapshotValue(req.threadId);
  const q = req.query;
  if (!q) return { snapshot: snap };
  const items = snap.items;
  let since: number | null = null;
  if (q.since) {
    const byId = items.find((it) => it.id === q.since);
    const n = byId ? Number(byId.ordinal ?? 0) : Number(q.since.replace(/^#/, ""));
    if (!Number.isFinite(n) || n < 0) throw new CommandError("notfound", `the thread has no item ${q.since} (give an item id or an ordinal)`);
    since = n;
  }
  let sel = items.filter((it) => (since === null || Number(it.ordinal ?? 0) > since) && roleMatches(q.role, it));
  let more = false;
  if (q.last > 0 && sel.length > q.last) {
    const byOrd = [...sel].sort((a, b) => Number(a.ordinal ?? 0) - Number(b.ordinal ?? 0));
    sel = since === null ? byOrd.slice(-q.last) : byOrd.slice(0, q.last);
    more = since !== null;
  }
  return { page: { threadId: req.threadId, items: sel, nextSince: sel.at(-1)?.id ?? q.since, more } };
}
