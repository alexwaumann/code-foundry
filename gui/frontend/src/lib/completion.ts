/**
 * The composer's inline completion: `/` offers skills (stores/skills.ts), `@` files
 * (stores/files.ts). Pure pieces only: where a trigger is, when the card shows, how skills
 * are matched, ranked and grouped, and how file matches become rows. The editor reports
 * triggers (components/compose/PromptEditor.tsx); components/compose/useCompletion.ts
 * runs the card.
 */
import type { FileMatchView, SkillSourceView, SkillView } from "@/api/filesystem";
import type { WorktreeChoice } from "./compose";
import type { PromptTag } from "./prompt";

/** The characters that start a completion. */
export type TriggerChar = "/" | "@";

/** A trigger at the caret: the trigger character and what was typed after it. */
export interface Trigger {
  char: TriggerChar;
  query: string;
  /** Offset of the trigger character in `before`. */
  offset: number;
}

/** One row of the completion card. */
export interface CompletionItem {
  key: string;
  /** Bold: `/deploy`, `session.go`. */
  label: string;
  /** The label in monospace (file names). */
  mono?: boolean;
  /** Muted, after the label (may be empty). */
  detail: string;
  /** Ranges of `detail` to emphasize ([from, to)): a file path's matched characters. */
  emphasis?: readonly (readonly [number, number])[];
  /** What Enter puts into the prompt. */
  tag: PromptTag;
}

/** A group of rows under an optional heading: a project (dot + name) or "User". */
export interface CompletionGroup {
  key: string;
  heading: { kind: "project"; repoId: string } | { kind: "user" } | null;
  items: CompletionItem[];
}

/** What an inline leaf (a tag) reads as in the text before the caret. */
export const LEAF_CHAR = "￼";

/**
 * The trigger the caret is in, from the text of its paragraph before it (tags as
 * LEAF_CHAR): a trigger character at the start or right after whitespace, then anything
 * but whitespace up to the caret. "and/or", "a@b" and "/x" right after a tag are not
 * triggers.
 */
export function findTrigger(before: string, chars: readonly TriggerChar[]): Trigger | null {
  const m = /(^|\s)([/@])([^\s￼]*)$/.exec(before);
  if (!m) return null;
  const char = m[2] as TriggerChar;
  if (!chars.includes(char)) return null;
  const query = m[3] ?? "";
  return { char, query, offset: before.length - query.length - 1 };
}

/** What the card shows for a trigger. */
export type CardShow = "list" | "empty" | "none";

/**
 * What the card remembers about the trigger it last answered: where the trigger is
 * (its document position), the query, whether nothing matched, and whether Escape
 * dismissed it.
 */
export interface CardMemo {
  at: number;
  query: string;
  empty: boolean;
  dismissed: boolean;
}

/**
 * The card for a trigger at `at` with `count` matches, given what it showed last.
 * A query with matches shows them. The first query without matches says so ("No skills
 * match"); typing on from there closes the card (a longer query cannot match again), and
 * Backspace back to a matching query opens it again. A dismissed trigger (Escape) stays
 * closed until the caret leaves it. Idempotent for the same inputs, so it can run on
 * every render.
 */
export function nextCard(prev: CardMemo | null, trigger: { at: number; query: string } | null, count: number): { show: CardShow; memo: CardMemo | null } {
  if (!trigger) return { show: "none", memo: null };
  const same = prev !== null && prev.at === trigger.at;
  if (same && prev.dismissed) return { show: "none", memo: prev };
  if (count > 0) return { show: "list", memo: { at: trigger.at, query: trigger.query, empty: false, dismissed: false } };
  if (same && prev.empty && prev.query !== trigger.query) return { show: "none", memo: prev };
  return { show: "empty", memo: { at: trigger.at, query: trigger.query, empty: true, dismissed: false } };
}

/** The memo after Escape on a trigger: closed until the caret leaves it. */
export function dismissCard(trigger: { at: number; query: string }): CardMemo {
  return { at: trigger.at, query: trigger.query, empty: false, dismissed: true };
}

// ---- skills ----------------------------------------------------------------------------

function isSubsequence(s: string, q: string): boolean {
  let j = 0;
  for (let i = 0; i < s.length && j < q.length; i++) if (s[i] === q[j]) j++;
  return j === q.length;
}

/**
 * How well a skill matches what was typed after "/" (case-insensitive): 5 the name, 4 a
 * prefix of it, 3 a subsequence of it, 2 a prefix of a word of the description, 0 no
 * match. An empty query matches everything (1).
 */
export function skillScore(s: Pick<SkillView, "name" | "description">, query: string): number {
  const q = query.toLowerCase();
  if (q === "") return 1;
  const name = s.name.toLowerCase();
  if (name === q) return 5;
  if (name.startsWith(q)) return 4;
  if (isSubsequence(name, q)) return 3;
  const words = s.description.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return words.some((w) => w.startsWith(q)) ? 2 : 0;
}

/** A group of the card: a project's skills (repoId) or the user's (repoId ""). */
export interface SkillGroup {
  repoId: string;
  skills: SkillView[];
}

/**
 * The skills matching a query, grouped: the projects in member order, then the user's.
 * Within a group: best score first, then the daemon's order (by name). A skill listed
 * twice in one group (a skill and a command of the same name) shows once. Project
 * skills of a repo that is not a member are left out.
 */
export function groupSkills(skills: readonly SkillView[], query: string, members: readonly string[]): SkillGroup[] {
  const order = [...members, ""];
  const buckets = new Map<string, { s: SkillView; score: number; i: number }[]>(order.map((id) => [id, []]));
  const seen = new Set<string>();
  skills.forEach((s, i) => {
    const repoId = s.scope === "user" ? "" : s.repoId;
    const bucket = buckets.get(repoId);
    const key = `${repoId}\u0000${s.name}`;
    if (!bucket || seen.has(key)) return;
    const score = skillScore(s, query);
    if (score === 0) return;
    seen.add(key);
    bucket.push({ s, score, i });
  });
  return order.flatMap((repoId) => {
    const hits = buckets.get(repoId) ?? [];
    if (hits.length === 0) return [];
    hits.sort((a, b) => b.score - a.score || a.i - b.i);
    return [{ repoId, skills: hits.map((h) => h.s) }];
  });
}

/** What the skill sources depend on: the draft's projects and where its thread would run. */
export interface SkillSourceInput {
  target: "project" | "workspace";
  /** The draft's projects in member order (lib/compose draftMembers). */
  repoIds: readonly string[];
  /** The resolved worktree choice. */
  worktree: WorktreeChoice;
  /** A workspace's members and their worktrees. */
  wsMembers: readonly { repoId: string; worktreePath: string }[];
}

/**
 * The checkouts to read project skills from, in member order: a workspace's member
 * worktrees; a lone project's chosen existing worktree; else each project's main
 * worktree (path left out). The daemon adds the user's.
 */
export function skillSources(input: SkillSourceInput): SkillSourceView[] {
  return input.repoIds.map((repoId) => {
    if (input.target === "workspace") {
      const path = input.wsMembers.find((m) => m.repoId === repoId)?.worktreePath;
      return path ? { repoId, path } : { repoId };
    }
    if (input.repoIds.length === 1 && input.worktree.kind === "existing") return { repoId, path: input.worktree.path };
    return { repoId };
  });
}

/** A stable key for a source list (the skills cache's key). */
export function skillSourcesKey(sources: readonly SkillSourceView[]): string {
  return sources.map((s) => `${s.repoId}\u0001${s.path ?? ""}`).join("\u0002");
}

// ---- files -----------------------------------------------------------------------------

/** What the file sources depend on: like skills', but a workspace's mode matters. */
export interface FileSourceInput {
  target: "project" | "workspace";
  /** The draft's projects in member order (lib/compose draftMembers). */
  repoIds: readonly string[];
  /** The resolved worktree choice ("members": a workspace's own worktrees). */
  worktree: WorktreeChoice;
  /** A workspace's members and their worktrees. */
  wsMembers: readonly { repoId: string; worktreePath: string }[];
}

/**
 * The checkouts "@" searches, in member order: where the thread will find the files. A
 * workspace in "Workspace worktrees" mode: each member's worktree; a lone project's chosen
 * existing worktree; else (new worktrees, a project with "Also in" projects) each
 * project's main worktree (path left out), which the new worktrees start from.
 */
export function fileSources(input: FileSourceInput): SkillSourceView[] {
  return input.repoIds.map((repoId) => {
    if (input.target === "workspace") {
      const path = input.worktree.kind === "members" ? input.wsMembers.find((m) => m.repoId === repoId)?.worktreePath : undefined;
      return path ? { repoId, path } : { repoId };
    }
    if (input.repoIds.length === 1 && input.worktree.kind === "existing") return { repoId, path: input.worktree.path };
    return { repoId };
  });
}

/** A stable key for a file source list (the files cache's key). */
export const fileSourcesKey = skillSourcesKey;

/** Positions of `q` as a greedy subsequence of `s` from `start`, or null. */
function subsequenceAt(s: string, q: string, start: number): number[] | null {
  const hits: number[] = [];
  let j = 0;
  for (let i = start; i < s.length && j < q.length; i++) {
    if (s[i] === q[j]) {
      hits.push(i);
      j++;
    }
  }
  return j === q.length ? hits : null;
}

function toRanges(hits: readonly number[]): [number, number][] {
  const out: [number, number][] = [];
  for (const i of hits) {
    const last = out.at(-1);
    if (last?.[1] === i) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

/**
 * The characters of a path to emphasize for a query (case-insensitive; the daemon ranks,
 * this only marks): the query as a run in the base name, else spread over the base name,
 * else as a run anywhere, else spread over the whole path. [] when it does not match.
 */
export function emphasis(path: string, query: string): [number, number][] {
  const q = query.toLowerCase();
  if (q === "") return [];
  const p = path.toLowerCase();
  const base = p.lastIndexOf("/") + 1;
  const run = (i: number): [number, number][] => [[i, i + q.length]];
  const inBase = p.indexOf(q, base);
  if (inBase >= 0) return run(inBase);
  const spreadBase = subsequenceAt(p, q, base);
  if (spreadBase) return toRanges(spreadBase);
  const anywhere = p.indexOf(q);
  if (anywhere >= 0) return run(anywhere);
  return toRanges(subsequenceAt(p, q, 0) ?? []);
}

/** One checkout's answer to a search. */
export interface FileResults {
  repoId: string;
  matches: readonly FileMatchView[];
}

/**
 * The card's rows for file matches: a group per project with matches, the primary first,
 * then member order; headings only when the draft has more than one project. A row is
 * the base name (a directory's with a trailing "/") and the path with the query's
 * characters emphasized; it inserts a file tag (a directory's path keeps its "/"). Rows
 * keep the daemon's order. Results of a project that is not a member are left out.
 */
export function fileItems(results: readonly FileResults[], query: string, members: readonly string[], primary: string): CompletionGroup[] {
  const order = members.includes(primary) ? [primary, ...members.filter((m) => m !== primary)] : [...members];
  const multi = members.length > 1;
  return order.flatMap((repoId): CompletionGroup[] => {
    const matches = results.find((r) => r.repoId === repoId)?.matches ?? [];
    if (matches.length === 0) return [];
    const items = matches.map((m): CompletionItem => {
      const base = m.path.slice(m.path.lastIndexOf("/") + 1);
      return {
        key: `${repoId}/${m.path}${m.isDir ? "/" : ""}`,
        label: m.isDir ? `${base}/` : base,
        mono: true,
        detail: m.path,
        emphasis: emphasis(m.path, query),
        tag: { tagKind: "file", repoId, path: m.isDir ? `${m.path}/` : m.path },
      };
    });
    return [{ key: repoId, heading: multi ? { kind: "project", repoId } : null, items }];
  });
}
