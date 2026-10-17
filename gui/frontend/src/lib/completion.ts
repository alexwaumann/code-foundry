/**
 * The composer's inline completion: `/` offers skills (stores/skills.ts), or a running
 * thread's slash commands (stores/thread.ts useSlashCommands), `@` files (stores/files.ts). Pure pieces only: where a trigger is, when the card shows, how skills
 * are matched, ranked and grouped, and how file matches become rows. The editor reports
 * triggers (components/compose/PromptEditor.tsx); components/compose/useCompletion.ts
 * runs the card.
 */
import type { FileMatchView, SkillSourceView, SkillView } from "@/api/filesystem";
import type { SlashCommandView } from "@/api/slashCommands";
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
  /** Bold: `/deploy`, `thread.go`. */
  label: string;
  /** The label in monospace (file names). */
  mono?: boolean;
  /** Muted, right after the label: a command's argument hint ("[interval] [prompt]"). */
  hint?: string;
  /** Muted, after the label (may be empty). */
  detail: string;
  /** Ranges of `detail` to emphasize ([from, to)): a file path's matched characters. */
  emphasis?: readonly (readonly [number, number])[];
  /** What Enter puts into the prompt: a tag, or plain text (a built-in command's "/compact"). */
  tag: PromptTag | string;
}

/** A group of rows under an optional heading: a project (dot + name), "User", or a plain label ("Claude Code"). */
export interface CompletionGroup {
  key: string;
  heading: { kind: "project"; projectId: string } | { kind: "user" } | { kind: "label"; text: string } | null;
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

/** A group of the card: a project's skills (projectId) or the user's (projectId ""). */
export interface SkillGroup {
  projectId: string;
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
    const projectId = s.scope === "user" ? "" : s.projectId;
    const bucket = buckets.get(projectId);
    const key = `${projectId}\u0000${s.name}`;
    if (!bucket || seen.has(key)) return;
    const score = skillScore(s, query);
    if (score === 0) return;
    seen.add(key);
    bucket.push({ s, score, i });
  });
  return order.flatMap((projectId) => {
    const hits = buckets.get(projectId) ?? [];
    if (hits.length === 0) return [];
    hits.sort((a, b) => b.score - a.score || a.i - b.i);
    return [{ projectId, skills: hits.map((h) => h.s) }];
  });
}

// ---- a running thread's slash commands ---------------------------------------------------

/**
 * How well a slash command matches what was typed after "/" (case-insensitive): 6 the
 * name, 5 a prefix of it or an alias ("/cost" finds usage), 4 inside the name or a prefix
 * of an alias, 3 a subsequence of the name, 2 a prefix of a description word, 0 no match.
 * An empty query matches everything (1). 4 and up are name matches (STRONG_MATCH).
 */
export function commandScore(c: Pick<SlashCommandView, "name" | "description" | "aliases">, query: string): number {
  const q = query.toLowerCase();
  if (q === "") return 1;
  const name = c.name.toLowerCase();
  if (name === q) return 6;
  const aliases = c.aliases.map((a) => a.toLowerCase());
  if (name.startsWith(q) || aliases.includes(q)) return 5;
  if (name.includes(q) || aliases.some((a) => a.startsWith(q))) return 4;
  if (isSubsequence(name, q)) return 3;
  const words = c.description.toLowerCase().split(/[^\p{L}\p{N}]+/u);
  return words.some((w) => w.startsWith(q)) ? 2 : 0;
}

/** commandScore of a match by name or alias (not a scattered subsequence, not the description). */
export const STRONG_MATCH = 4;

/** A command's description on one line (descriptions can be whole paragraphs; the row truncates the rest). */
export function firstLine(text: string): string {
  return text.split(/\r?\n/, 1)[0]?.trim() ?? "";
}

/** The group keys after the projects': the user's skills, other skills, Claude Code's own. */
const USER = "";
const OTHER = "\u0001skills";
const BUILTIN = "\u0001claude";

/**
 * The card's rows for a running thread's slash commands (Claude's list, which is what
 * "/name" runs). A command the disk scan (ListSkills: `skills`) knows by name keeps its
 * scope and today's tag: a project's under that project (member order; headings only
 * when the draft has more than one project), the user's under "User". Claude Code's own
 * (builtin, bundled skills included) go under "Claude Code", last, and insert "/name" as
 * plain text (they take free-form arguments). Anything else (a plugin's skill, a skill
 * the scan did not see) goes under "Skills" and inserts plain text too: there is no
 * scope to name in a tag. When anything matches by name or alias, weaker matches
 * (subsequence, description) are left out. Within a group: best score first, then
 * Claude's order. A row
 * shows the argument hint and the description's first line; aliases only match.
 */
export function commandItems(commands: readonly SlashCommandView[], skills: readonly SkillView[], query: string, members: readonly string[]): CompletionGroup[] {
  const order = [...members, USER, OTHER, BUILTIN];
  const buckets = new Map<string, { item: CompletionItem; score: number; i: number }[]>(order.map((k) => [k, []]));
  const scopeOf = (name: string): string | null => {
    for (const m of members) if (skills.some((s) => s.scope === "project" && s.projectId === m && s.name === name)) return m;
    return skills.some((s) => s.scope === "user" && s.name === name) ? USER : null;
  };
  const scores = commands.map((c) => commandScore(c, query));
  // Claude's list is long and its descriptions are paragraphs: once anything matches by
  // name or alias, scattered and description matches would only bury it.
  const floor = scores.some((x) => x >= STRONG_MATCH) ? STRONG_MATCH : 1;
  commands.forEach((c, i) => {
    const score = scores[i] ?? 0;
    if (score < floor) return;
    const scope = c.builtin ? null : scopeOf(c.name);
    const group = c.builtin ? BUILTIN : (scope ?? OTHER);
    const item: CompletionItem = {
      key: c.name,
      label: `/${c.name}`,
      hint: c.argumentHint,
      detail: firstLine(c.description),
      tag: scope === null ? `/${c.name}` : { tagKind: "skill", name: c.name, projectId: scope },
    };
    buckets.get(group)?.push({ item, score, i });
  });
  const multi = members.length > 1;
  const heading = (key: string): CompletionGroup["heading"] => {
    if (key === USER) return { kind: "user" };
    if (key === OTHER) return { kind: "label", text: "Skills" };
    if (key === BUILTIN) return { kind: "label", text: "Claude Code" };
    return multi ? { kind: "project", projectId: key } : null;
  };
  return order.flatMap((key) => {
    const hits = buckets.get(key) ?? [];
    if (hits.length === 0) return [];
    hits.sort((a, b) => b.score - a.score || a.i - b.i);
    return [{ key: key === USER ? "~" : key, heading: heading(key), items: hits.map((h) => h.item) }];
  });
}

/** What the skill sources depend on: the draft's projects and where its thread would run. */
export interface SkillSourceInput {
  target: "project" | "workspace";
  /** The draft's projects in member order (lib/compose draftMembers). */
  projectIds: readonly string[];
  /** The resolved worktree choice. */
  worktree: WorktreeChoice;
  /** A workspace's members and their worktrees. */
  wsMembers: readonly { projectId: string; worktreePath: string }[];
}

/**
 * The checkouts to read project skills from, in member order: a workspace's member
 * worktrees; a lone project's chosen existing worktree; else each project's main
 * worktree (path left out). The daemon adds the user's.
 */
export function skillSources(input: SkillSourceInput): SkillSourceView[] {
  return input.projectIds.map((projectId) => {
    if (input.target === "workspace") {
      const path = input.wsMembers.find((m) => m.projectId === projectId)?.worktreePath;
      return path ? { projectId, path } : { projectId };
    }
    if (input.projectIds.length === 1 && input.worktree.kind === "existing") return { projectId, path: input.worktree.path };
    return { projectId };
  });
}

/** A stable key for a source list (the skills cache's key). */
export function skillSourcesKey(sources: readonly SkillSourceView[]): string {
  return sources.map((s) => `${s.projectId}\u0001${s.path ?? ""}`).join("\u0002");
}

// ---- files -----------------------------------------------------------------------------

/** What the file sources depend on: like skills', but a workspace's mode matters. */
export interface FileSourceInput {
  target: "project" | "workspace";
  /** The draft's projects in member order (lib/compose draftMembers). */
  projectIds: readonly string[];
  /** The resolved worktree choice ("members": a workspace's own worktrees). */
  worktree: WorktreeChoice;
  /** A workspace's members and their worktrees. */
  wsMembers: readonly { projectId: string; worktreePath: string }[];
}

/**
 * The checkouts "@" searches, in member order: where the thread will find the files. A
 * workspace in "Workspace worktrees" mode: each member's worktree; a lone project's chosen
 * existing worktree; else (new worktrees, a project with "Also in" projects) each
 * project's main worktree (path left out), which the new worktrees start from.
 */
export function fileSources(input: FileSourceInput): SkillSourceView[] {
  return input.projectIds.map((projectId) => {
    if (input.target === "workspace") {
      const path = input.worktree.kind === "members" ? input.wsMembers.find((m) => m.projectId === projectId)?.worktreePath : undefined;
      return path ? { projectId, path } : { projectId };
    }
    if (input.projectIds.length === 1 && input.worktree.kind === "existing") return { projectId, path: input.worktree.path };
    return { projectId };
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

/** Lower case with the positions of `s` (a character whose lower case is longer, "İ", stays). */
function lowerInPlace(s: string): string {
  const l = s.toLowerCase();
  if (l.length === s.length) return l;
  return Array.from(s, (ch) => {
    const c = ch.toLowerCase();
    return c.length === ch.length ? c : ch;
  }).join("");
}

/**
 * The characters of a path to emphasize for a query (case-insensitive; the daemon ranks,
 * this only marks): the query as a run in the base name, else spread over the base name,
 * else as a run anywhere, else spread over the whole path. [] when it does not match.
 */
export function emphasis(path: string, query: string): [number, number][] {
  const q = lowerInPlace(query);
  if (q === "") return [];
  const p = lowerInPlace(path);
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
  projectId: string;
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
  return order.flatMap((projectId): CompletionGroup[] => {
    const matches = results.find((r) => r.projectId === projectId)?.matches ?? [];
    if (matches.length === 0) return [];
    const items = matches.map((m): CompletionItem => {
      const base = m.path.slice(m.path.lastIndexOf("/") + 1);
      return {
        key: `${projectId}/${m.path}${m.isDir ? "/" : ""}`,
        label: m.isDir ? `${base}/` : base,
        mono: true,
        detail: m.path,
        emphasis: emphasis(m.path, query),
        tag: { tagKind: "file", projectId, path: m.isDir ? `${m.path}/` : m.path },
      };
    });
    return [{ key: projectId, heading: multi ? { kind: "project", projectId } : null, items }];
  });
}
