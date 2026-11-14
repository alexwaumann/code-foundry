/**
 * Thread search (ThreadService.Search; docs/notes/search-3-index.md) mapped to view models
 * for the Find dialog (docs/notes/search-4-find-dialog.md). Generated types stay in this
 * file. The daemon's match ranges count code points; the views count UTF-16 units, as
 * JavaScript strings do, so `text.slice(start, end)` is the match.
 */
import { ThreadItemRole, ThreadService } from "@/gen/codefoundry/v1/thread_pb";
import { SearchSpeaker, type SearchHit, type SearchMatchRange, type SearchThreadGroup, type SearchThreadName, type SearchThreadsResponse } from "@/gen/codefoundry/v1/thread_search_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { toThreadItemView, type ThreadItemView } from "./thread";
import { ms } from "./timestamp";

/** A match in a text: [start, end) in UTF-16 units. */
export interface TextRange {
  start: number;
  end: number;
}

/** Whose text a hit is: the user's message, Claude's text, or Claude's question and its answer. */
export type SearchSpeakerView = "user" | "assistant" | "question";

/** A thread whose name matches. */
export interface SearchNameView {
  threadId: string;
  name: string;
  ranges: readonly TextRange[];
  archived: boolean;
  lastActivityMs: number | null;
}

/** One item that matches: a one-line snippet of its indexed text with the matches in it. */
export interface SearchHitView {
  threadId: string;
  itemId: string;
  ordinal: number;
  speaker: SearchSpeakerView;
  createdAtMs: number | null;
  /** The item's indexed text on one line, cut around its first match ("…" where cut). Not the item's text. */
  snippet: string;
  /** The matches in snippet only. */
  ranges: readonly TextRange[];
}

/** One thread's message hits, at most per_thread of them, in conversation order. */
export interface SearchGroupView {
  threadId: string;
  /** The thread's current name; "" when it has none yet. */
  threadName: string;
  archived: boolean;
  /** Every item of the thread that matches (hits holds the best few). */
  totalHits: number;
  hits: readonly SearchHitView[];
}

/** A search's answer. */
export interface SearchResultView {
  /** The query this answers. */
  query: string;
  /** Thread names, most recently active first. */
  threads: readonly SearchNameView[];
  /** Message hits by thread, the best first. */
  groups: readonly SearchGroupView[];
  /** The query has an upper-case letter: matches are exact. */
  caseSensitive: boolean;
  /** Every term is shorter than three characters: only names were searched. */
  namesOnly: boolean;
  totalHits: number;
  totalThreads: number;
  /** More items matched than the daemon reads: the hits and totals are among the most recent. */
  truncated: boolean;
}

/**
 * Code-point ranges into `text` as UTF-16 ranges. An astral character (an emoji) is one
 * code point and two UTF-16 units, so every range after one shifts. Ranges past the end
 * clamp to it; an empty or reversed one is dropped.
 */
export function codePointRanges(text: string, ranges: readonly { start: number; end: number }[]): TextRange[] {
  if (ranges.length === 0) return [];
  // offsets[k]: the UTF-16 index of code point k (and the text's length past the last).
  const offsets: number[] = [];
  let i = 0;
  for (const ch of text) {
    offsets.push(i);
    i += ch.length;
  }
  offsets.push(text.length);
  const at = (cp: number) => offsets[Math.max(0, Math.min(cp, offsets.length - 1))] ?? text.length;
  const out: TextRange[] = [];
  for (const r of ranges) {
    const start = at(r.start);
    const end = at(r.end);
    if (end > start) out.push({ start, end });
  }
  return out;
}

const speakers: Record<SearchSpeaker, SearchSpeakerView> = {
  [SearchSpeaker.UNSPECIFIED]: "assistant",
  [SearchSpeaker.USER]: "user",
  [SearchSpeaker.ASSISTANT]: "assistant",
  [SearchSpeaker.QUESTION]: "question",
};

function rangesOf(text: string, ranges: readonly SearchMatchRange[]): TextRange[] {
  return codePointRanges(
    text,
    ranges.map((r) => ({ start: r.start, end: r.end })),
  );
}

export function toSearchNameView(n: SearchThreadName): SearchNameView {
  return { threadId: n.threadId, name: n.name, ranges: rangesOf(n.name, n.ranges), archived: n.archived, lastActivityMs: ms(n.lastActivityAt) };
}

export function toSearchHitView(h: SearchHit): SearchHitView {
  return {
    threadId: h.threadId,
    itemId: h.itemId,
    ordinal: Number(h.ordinal),
    speaker: speakers[h.speaker],
    createdAtMs: ms(h.createdAt),
    snippet: h.snippet,
    ranges: rangesOf(h.snippet, h.ranges),
  };
}

export function toSearchGroupView(g: SearchThreadGroup): SearchGroupView {
  return { threadId: g.threadId, threadName: g.threadName, archived: g.archived, totalHits: g.totalHits, hits: g.hits.map(toSearchHitView) };
}

export function toSearchResultView(query: string, r: SearchThreadsResponse): SearchResultView {
  return {
    query,
    threads: r.threads.map(toSearchNameView),
    groups: r.groups.map(toSearchGroupView),
    caseSensitive: r.caseSensitive,
    namesOnly: r.namesOnly,
    totalHits: r.totalHits,
    totalThreads: r.totalThreads,
    truncated: r.truncated,
  };
}

/** How many hits the dialog shows per thread (the rest is "N more"). */
export const HITS_PER_THREAD = 3;

/** ThreadService.Search over the default scope (what the sidebar can show, archived included). */
export async function searchThreads(query: string, opts: { limit?: number; perThread?: number; signal?: AbortSignal } = {}, conn: DaemonConnection = daemon): Promise<SearchResultView> {
  const c = await conn.client(ThreadService);
  const res = await c.search({ query, limit: opts.limit ?? 0, perThread: opts.perThread ?? HITS_PER_THREAD }, { signal: opts.signal });
  return toSearchResultView(query, res);
}

/** A page of a thread's items (ListItems with a query), as views. */
async function readPage(threadId: string, query: { since?: string; last?: number; role?: ThreadItemRole }, conn: DaemonConnection): Promise<ThreadItemView[]> {
  const c = await conn.client(ThreadService);
  const res = await c.listItems({ threadId, query: { since: query.since ?? "", last: query.last ?? 0, role: query.role ?? ThreadItemRole.UNSPECIFIED } });
  return (res.page?.items ?? []).flatMap((it) => {
    const v = toThreadItemView(it);
    return v ? [v] : [];
  });
}

/** The item a hit names, whole (ListItems since ordinal - 1, last 1); null when it is gone. */
export async function readHitItem(threadId: string, itemId: string, ordinal: number, conn: DaemonConnection = daemon): Promise<ThreadItemView | null> {
  const items = await readPage(threadId, { since: String(Math.max(0, ordinal - 1)), last: 1 }, conn);
  return items.find((it) => it.id === itemId) ?? null;
}

/** How many items before a hit the preview reads first, looking for the prompt it answers. */
export const PROMPT_WINDOW = 40;

/** Per thread, its own user messages (role USER), read once for the dialog's life. */
export type PromptCache = Map<string, Promise<readonly ThreadItemView[]>>;

/** The last of items that is the thread's own user message (not a wake, not a subagent's) before ordinal; null for none. */
function lastPromptBefore(items: readonly ThreadItemView[], ordinal: number): ThreadItemView | null {
  let best: ThreadItemView | null = null;
  for (const it of items) {
    if (it.kind !== "user" || it.wake || it.parentToolUseId !== "" || it.ordinal >= ordinal) continue;
    if (!best || it.ordinal > best.ordinal) best = it;
  }
  return best;
}

/**
 * The user's message before an item (the prompt Claude's text answers): the thread's own
 * last user message before `ordinal`; null for none. First the PROMPT_WINDOW items just
 * before it (any role: the prompt is usually a few steps back); only when that window has
 * none and does not reach the thread's start, the thread's user messages, read once per
 * thread into `cache` (the API has no "before" query, and a long thread has thousands).
 */
export async function readPromptBefore(threadId: string, ordinal: number, cache: PromptCache = new Map(), conn: DaemonConnection = daemon): Promise<ThreadItemView | null> {
  const from = ordinal - PROMPT_WINDOW - 1;
  const near = lastPromptBefore(await readPage(threadId, { since: String(Math.max(0, from)), last: PROMPT_WINDOW }, conn), ordinal);
  if (near || from <= 0) return near;
  let users = cache.get(threadId);
  if (!users) {
    users = readPage(threadId, { role: ThreadItemRole.USER }, conn);
    cache.set(threadId, users);
    // A failed read is not kept: the next row asks again.
    users.catch(() => cache.delete(threadId));
  }
  return lastPromptBefore(await users, ordinal);
}

/**
 * A thread's latest text from Claude, for a name match's preview; null for none. The last
 * few texts (role ASSISTANT), as a subagent's text or an API error may be the very last.
 */
export async function readLastReply(threadId: string, conn: DaemonConnection = daemon): Promise<ThreadItemView | null> {
  const items = await readPage(threadId, { role: ThreadItemRole.ASSISTANT, last: 8 }, conn);
  return items.filter((it) => it.kind === "text" && it.parentToolUseId === "" && !it.apiError).at(-1) ?? null;
}

/** How many of a thread's last tool items the Needs-you card reads looking for the ask. */
export const ASK_WINDOW = 12;

/**
 * A pending ask's own item and the last text Claude wrote (docs/notes/shell-17-needs-you.md),
 * read without a Watch: the thread's last tool items (permissions and questions are tools) and
 * its last two replies. The ask is null when it is not among them (answered meanwhile).
 */
export async function readAskItems(threadId: string, itemId: string, conn: DaemonConnection = daemon): Promise<{ ask: ThreadItemView | null; replies: ThreadItemView[] }> {
  const [tools, replies] = await Promise.all([readPage(threadId, { last: ASK_WINDOW, role: ThreadItemRole.TOOL }, conn), readPage(threadId, { last: 2, role: ThreadItemRole.ASSISTANT }, conn)]);
  return { ask: tools.find((it) => it.id === itemId) ?? null, replies };
}
