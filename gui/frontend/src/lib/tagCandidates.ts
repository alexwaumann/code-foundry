/**
 * What the composer offers to tag besides skills and files (docs/notes/composer-thread-pr-tags.md):
 * other threads under `@` (a "Threads" group above "Files") and pull requests after `#`.
 * Both come from what the GUI already holds: the thread list (stores/threads.ts) and the
 * pull requests the daemon polls (stores/gh.ts: the dashboards and the branches on
 * screen). Pure: matching, ranking, caps and rows.
 */
import type { PullRequestView } from "@/api/gh";
import type { ThreadView } from "@/api/threads";
import type { CompletionItem } from "./completion";
import { threadLabel } from "./prompt";

/** At most this many threads above the files. */
export const THREAD_ROWS = 3;
/** At most this many pull requests in the `#` card. */
export const PR_ROWS = 5;

/** The words of a text, lower case, for word-prefix matches. */
function words(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u);
}

/**
 * How well a thread's name matches what was typed after "@" (case-insensitive): 5 the
 * name, 4 a prefix of it, 3 a prefix of one of its words, 2 inside it, 0 no match. An
 * empty query matches everything (1).
 */
export function threadScore(name: string, query: string): number {
  const q = query.toLowerCase();
  if (q === "") return 1;
  const n = name.toLowerCase();
  if (n === q) return 5;
  if (n.startsWith(q)) return 4;
  if (words(n).some((w) => w.startsWith(q))) return 3;
  return n.includes(q) ? 2 : 0;
}

export type ThreadCandidate = Pick<ThreadView, "id" | "name" | "archivedAtMs" | "snoozedUntilMs" | "lastActivityAtMs" | "createdAtMs">;

/**
 * The threads a `@` query offers: active ones only (not archived, not snoozed), never the
 * thread being written in, matching by name; best match first, then the most recently
 * active; at most `cap`.
 */
export function threadCandidates<T extends ThreadCandidate>(threads: Iterable<T>, query: string, currentId: string, cap = THREAD_ROWS): T[] {
  const hits: { t: T; score: number; at: number }[] = [];
  for (const t of threads) {
    if (t.id === currentId || t.archivedAtMs !== null || t.snoozedUntilMs !== null) continue;
    const score = threadScore(t.name || t.id, query);
    if (score > 0) hits.push({ t, score, at: t.lastActivityAtMs ?? t.createdAtMs ?? 0 });
  }
  hits.sort((a, b) => b.score - a.score || b.at - a.at || a.t.id.localeCompare(b.t.id));
  return hits.slice(0, cap).map((h) => h.t);
}

/** A thread row: its name, then its project and what it is doing, muted. */
export interface ThreadRow {
  id: string;
  name: string;
  /** "code-foundry · Working". */
  detail: string;
}

export function threadItems(rows: readonly ThreadRow[]): CompletionItem[] {
  return rows.map((r) => {
    const name = threadLabel(r.name, r.id);
    return { key: `thread:${r.id}`, label: name, detail: r.detail, tag: { tagKind: "thread", id: r.id, name } };
  });
}

// ---- pull requests ---------------------------------------------------------------------

/** The pull request key the pool deduplicates on: "owner/repo#123", lower case. */
export function prKey(slug: string, number: number): string {
  return `${slug.toLowerCase()}#${String(number)}`;
}

/**
 * The pull requests the GUI knows in the given repositories ("owner/repo", any case),
 * from several lists (the dashboards, the branches' lists), each once: the first list
 * that has it wins.
 */
export function prPool(lists: readonly (readonly PullRequestView[])[], slugs: readonly string[]): PullRequestView[] {
  const want = new Set(slugs.map((s) => s.toLowerCase()));
  const seen = new Set<string>();
  const out: PullRequestView[] = [];
  for (const list of lists) {
    for (const pr of list) {
      const key = prKey(pr.repoSlug, pr.number);
      if (!want.has(pr.repoSlug.toLowerCase()) || seen.has(key) || pr.partial) continue;
      seen.add(key);
      out.push(pr);
    }
  }
  return out;
}

/**
 * How well a pull request matches what was typed after "#" (case-insensitive): digits
 * match the number (6 exactly, 5 as its start); text matches the title (4 its start, 3 a
 * word's start, 2 inside it); 0 no match.
 */
export function prScore(pr: Pick<PullRequestView, "number" | "title">, query: string): number {
  const q = query.toLowerCase();
  if (q === "") return 0;
  if (/^\d+$/.test(q)) {
    const n = String(pr.number);
    if (n === q) return 6;
    if (n.startsWith(q)) return 5;
  }
  const title = pr.title.toLowerCase();
  if (title.startsWith(q)) return 4;
  if (words(title).some((w) => w.startsWith(q))) return 3;
  return title.includes(q) ? 2 : 0;
}

/** The pool's matches for a query: best first, then open ones, then the most recently updated; at most `cap`. */
export function prCandidates(pool: readonly PullRequestView[], query: string, cap = PR_ROWS): PullRequestView[] {
  return pool
    .map((pr) => ({ pr, score: prScore(pr, query) }))
    .filter((h) => h.score > 0)
    .sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.pr.state === "open") - Number(a.pr.state === "open") ||
        (b.pr.updatedAtMs ?? 0) - (a.pr.updatedAtMs ?? 0) ||
        b.pr.number - a.pr.number,
    )
    .slice(0, cap)
    .map((h) => h.pr);
}

/**
 * The `#` card's rows: #N, the title muted with the typed text emphasized, and with
 * more than one repository the repository as the hint. A pick inserts a pull request tag.
 */
export function prItems(prs: readonly PullRequestView[], query: string, multiRepo: boolean): CompletionItem[] {
  const q = query.toLowerCase();
  return prs.map((pr) => {
    const lower = pr.title.toLowerCase();
    // A title whose lower case is longer ("İ") would shift the offsets: no emphasis then.
    const at = q === "" || lower.length !== pr.title.length ? -1 : lower.indexOf(q);
    const slug = pr.repoSlug.toLowerCase();
    return {
      key: prKey(slug, pr.number),
      label: `#${String(pr.number)}`,
      ...(multiRepo ? { hint: slug } : {}),
      detail: pr.title,
      ...(at >= 0 ? { emphasis: [[at, at + q.length] as const] } : {}),
      tag: { tagKind: "pr", slug, number: pr.number },
    };
  });
}
