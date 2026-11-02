/**
 * FilesystemService over a fake home directory, mirroring internal/fsx: "~" expansion,
 * case-insensitive prefix match, dot-directories only for a "." segment, a 200-entry
 * bound, and InvalidArgument outside home. The tree holds the mock's registered projects
 * (world.ts) plus a few unregistered folders to add. ListSkills and SearchFiles (the
 * composer's "/" and "@" completion) are at the end.
 */
import { Code, ConnectError } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import {
  SkillScope,
  type ListDirectoriesResponseSchema,
  type SearchFilesResponseSchema,
  type SkillSchema,
} from "../src/gen/codefoundry/v1/filesystem_pb";

export const HOME = "/Users/dev";
const MAX_ENTRIES = 200;

/** A directory: children by name. `git` marks a .git entry inside. */
interface Dir {
  git?: boolean;
  children?: Record<string, Dir>;
}

const project: Dir = { git: true, children: { src: {}, docs: {} } };

const tree: Dir = {
  children: {
    src: {
      children: {
        "code-foundry": project,
        "code-foundry.worktrees": { children: { "feat-sidebar": { git: true }, "fix-resize": { git: true } } },
        "ghostty-playground": { git: true },
        sketches: { git: true },
        "new-app": { git: true, children: { web: {}, api: {} } },
        Notebook: {},
        Website: { git: true },
      },
    },
    dotfiles: { git: true },
    // A folder of repos (the Add Project dialog's workspace choice): three repos and a plain folder.
    product: { children: { web: { git: true }, api: { git: true }, "docs-site": { git: true }, notes: {} } },
    // A folder of repos whose "broken" child the mock's project.add-workspace refuses.
    mixed: { children: { ok: { git: true }, broken: { git: true } } },
    Documents: { children: { Projects: { children: { "side-project": { git: true } } } } },
    Downloads: {},
    Library: {},
    many: { children: Object.fromEntries(Array.from({ length: 205 }, (_, i) => [`d${String(i).padStart(3, "0")}`, {}])) },
    ".config": { children: { nvim: { git: true } } },
    ".ssh": {},
  },
};

type ListingInit = MessageInitShape<typeof ListDirectoriesResponseSchema>;

function invalid(msg: string): ConnectError {
  return new ConnectError(`invalid argument: ${msg}`, Code.InvalidArgument);
}

/** Resolves an absolute path ("/Users/dev/src") to its node, or undefined. */
function lookup(abs: string): Dir | undefined {
  if (abs === HOME) return tree;
  if (!abs.startsWith(`${HOME}/`)) return undefined;
  let node: Dir | undefined = tree;
  for (const seg of abs.slice(HOME.length + 1).split("/")) {
    if (seg === "") continue;
    node = node?.children?.[seg];
  }
  return node;
}

/** Normalizes "." and ".." segments of an absolute path. */
function clean(abs: string): string {
  const out: string[] = [];
  for (const seg of abs.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}

function within(path: string): boolean {
  return path.toLowerCase() === HOME.toLowerCase() || path.toLowerCase().startsWith(`${HOME.toLowerCase()}/`);
}

function commonFoldPrefix(names: string[]): string {
  const first = names[0] ?? "";
  let n = first.length;
  for (const other of names.slice(1)) {
    let i = 0;
    while (i < n && i < other.length && first[i]?.toLowerCase() === other[i]?.toLowerCase()) i++;
    n = i;
  }
  return first.slice(0, n);
}

export function listDirectories(rawPrefix: string, registered: ReadonlySet<string>): ListingInit {
  const prefix = rawPrefix === "" || rawPrefix === "~" ? "~/" : rawPrefix;
  let abs: string;
  if (prefix.startsWith("~/")) abs = HOME + prefix.slice(1);
  else if (prefix.startsWith("~")) throw invalid(`~user paths are not supported: "${prefix}"`);
  else if (!prefix.startsWith("/")) throw invalid(`want an absolute path or one starting with ~, got "${prefix}"`);
  else abs = prefix;
  const typedDir = prefix.slice(0, prefix.lastIndexOf("/") + 1);
  const base = prefix.slice(prefix.lastIndexOf("/") + 1);
  const dir = clean(abs.slice(0, abs.lastIndexOf("/") + 1));
  if (!within(dir)) throw invalid(`${prefix} is outside your home directory`);
  const node = lookup(dir);
  const empty: ListingInit = { entries: [], completion: prefix, truncated: false };
  if (!node?.children) return empty;

  const showDot = base.startsWith(".");
  const names = Object.keys(node.children)
    .filter((n) => (showDot || !n.startsWith(".")) && n.toLowerCase().startsWith(base.toLowerCase()))
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()) || a.localeCompare(b));
  if (names.length === 0) return empty;
  const completion = names.length === 1 ? `${typedDir}${names[0] ?? ""}/` : typedDir + commonFoldPrefix(names);
  const shown = names.slice(0, MAX_ENTRIES);
  return {
    entries: shown.map((name) => {
      const path = dir === "/" ? `/${name}` : `${dir}/${name}`;
      return { path, name, isGit: node.children?.[name]?.git === true, registered: registered.has(path) };
    }),
    completion,
    truncated: names.length > MAX_ENTRIES,
  };
}

/**
 * The project folder ProjectService.Register adds for an absolute, clean path under home,
 * like project.Register: the nearest enclosing git repository, else the folder itself as a
 * project without git. Undefined when the folder is not on the fake disk.
 */
export function projectFolder(abs: string): { path: string; git: boolean } | undefined {
  if (!lookup(abs)) return undefined;
  for (let dir = abs; within(dir); dir = dir.slice(0, dir.lastIndexOf("/")) || "/") {
    if (lookup(dir)?.git) return { path: dir, git: true };
    if (dir === HOME) break;
  }
  return { path: abs, git: false };
}

/**
 * ProjectService.InspectFolder over the tree: whether abs is (inside) a repository, else its
 * child repositories (immediate, not hidden), sorted by name case-insensitively. Undefined
 * when abs does not exist.
 */
export function folderInfo(abs: string): { path: string; isRepo: boolean; childRepos: { path: string; name: string }[] } | undefined {
  const node = lookup(abs);
  const folder = projectFolder(abs);
  if (!node || !folder) return undefined;
  if (folder.git) return { path: abs, isRepo: true, childRepos: [] };
  const childRepos = Object.entries(node.children ?? {})
    .filter(([name, d]) => !name.startsWith(".") && d.git)
    .map(([name]) => ({ path: `${abs}/${name}`, name }))
    .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return { path: abs, isRepo: false, childRepos };
}

// ---- composer completion and the file finder: ListSkills and SearchFiles ---------------
//
// Every project has the same small file list unless a test sets its own
// (POST /__mock/files?project=repo-cf&path=a.ts&path=src/b.ts, or several projects at once:
// ?project=repo-cf&path=a.ts&project=repo-gh&path=b.zig; no path: an empty project), and
// the project skills `review` and `deploy`; the user has `commit`. Ranking mirrors
// internal/fuzzy: exact base name > base name prefix > base name subsequence > path
// subsequence per query word, then the weakest word's tier, the tier sum and the bonus sum
// (fuzzy.ScoreWords), then shorter path, then path, then source order; an empty query lists
// the shallowest first. Several sources are ranked in one list and leading or trailing query
// words may match a project's name (fuzzy.Splits); positions are code-point indices, like
// the daemon's.

/** A project the completion RPCs can see: its id, name and main worktree (world.ts MockProject). */
export interface CompletionProject {
  id: string;
  name: string;
  path: string;
}

export const DEFAULT_FILES: readonly string[] = [
  "README.md",
  "package.json",
  "src/index.ts",
  "src/components/Composer.tsx",
  "src/components/ThreadRow.tsx",
  "docs/notes/x.md",
  ".claude/skills/review/SKILL.md",
  ".claude/skills/deploy/SKILL.md",
];

const PROJECT_SKILLS = [
  { name: "deploy", description: "Ship the current branch to staging.", file: ".claude/skills/deploy/SKILL.md" },
  { name: "review", description: "Review the diff against the base branch.", file: ".claude/skills/review/SKILL.md" },
];
const USER_SKILLS = [{ name: "commit", description: "Write a commit message and commit.", path: `${HOME}/.claude/skills/commit/SKILL.md` }];

const DEFAULT_FILE_LIMIT = 50;
const MAX_FILE_LIMIT = 200;

/** Files set by POST /__mock/files, by project id. */
const filesByProject = new Map<string, string[]>();
/** "skills <project,project|-> <user>" and "search <project> <query>", for specs that assert calls. */
export const completionCalls: string[] = [];

export function setMockFiles(projectId: string, files: string[]): void {
  filesByProject.set(projectId, files);
}

/** How SearchFiles answers (POST /__mock/files/search?delay=700&fail=1): after delayMs, failing when fail. */
export const searchMode = { delayMs: 0, fail: false };

export function resetCompletion(): void {
  filesByProject.clear();
  completionCalls.length = 0;
  searchMode.delayMs = 0;
  searchMode.fail = false;
}

type SkillInit = MessageInitShape<typeof SkillSchema>;
type SearchInit = MessageInitShape<typeof SearchFilesResponseSchema>;

/** The checkout a request names: path (one of the project's) or the main worktree. */
function completionCheckout(projects: ReadonlyMap<string, CompletionProject>, projectId: string, path: string): CompletionProject {
  if (projectId === "") throw invalid("project_id is required");
  const project = projects.get(projectId);
  if (!project) throw new ConnectError(`project ${projectId} not found`, Code.NotFound);
  if (path !== "" && !within(clean(path))) throw invalid(`${path} is outside your home directory`);
  return project;
}

export function listSkills(
  projects: ReadonlyMap<string, CompletionProject>,
  sources: readonly { projectId: string; path: string }[],
  includeUser: boolean,
): SkillInit[] {
  completionCalls.push(`skills ${sources.map((s) => s.projectId).join(",") || "-"} ${String(includeUser)}`);
  const out: SkillInit[] = [];
  for (const src of sources) {
    // Like the daemon: an unknown project is skipped; a malformed source fails.
    if (src.projectId !== "" && !projects.has(src.projectId)) continue;
    const project = completionCheckout(projects, src.projectId, src.path);
    const dir = src.path || project.path;
    for (const s of PROJECT_SKILLS) {
      out.push({ name: s.name, description: s.description, scope: SkillScope.PROJECT, projectId: project.id, path: `${dir}/${s.file}` });
    }
  }
  if (includeUser) {
    for (const s of USER_SKILLS) out.push({ name: s.name, description: s.description, scope: SkillScope.USER, projectId: "", path: s.path });
  }
  return out;
}

/** Files plus every directory they imply, directories first (internal/fsx WithParentDirs). */
function withParentDirs(files: readonly string[]): { path: string; isDir: boolean }[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (let i = f.indexOf("/"); i >= 0; i = f.indexOf("/", i + 1)) {
      const d = f.slice(0, i);
      if (!seen.has(d)) {
        seen.add(d);
        dirs.push(d);
      }
    }
  }
  return [...dirs.map((path) => ({ path, isDir: true })), ...files.map((path) => ({ path, isDir: false }))];
}

/** One checkout of a SearchFiles request. */
export interface SearchSource {
  projectId: string;
  path: string;
}

/** The SearchFiles request fields the mock reads (SearchFilesRequest). */
export interface SearchRequest {
  projectId: string;
  path: string;
  query: string;
  limit: number;
  sources: readonly SearchSource[];
  filesOnly: boolean;
}

const MAX_SOURCES = 16;
/** internal/fuzzy MaxWords: a query of more words is InvalidArgument. */
const MAX_WORDS = 8;
const BOUNDARY_BONUS = 4;
const NONE = -(2 ** 30);

/**
 * Code points, each lower-cased on its own so indices stay those of the original (Go's
 * unicode.ToLower). JavaScript lowers "İ" to "i" plus a combining dot; Go to "i", the first.
 */
function lowerRunes(s: string): string[] {
  return Array.from(s, (c) => Array.from(c.toLowerCase())[0] ?? c);
}

function isBoundary(c: string | undefined): boolean {
  return c === "/" || c === "." || c === "-" || c === "_" || c === " ";
}

/**
 * The best-bonus alignment of q in s (internal/fuzzy align): BOUNDARY_BONUS per character at
 * the start or after a separator, 1 per character right after the previous one. Undefined
 * when q is not a subsequence of s.
 */
function align(s: readonly string[], q: readonly string[]): { bonus: number; pos: number[] } | undefined {
  const n = s.length;
  const m = q.length;
  if (m === 0) return { bonus: 0, pos: [] };
  const bonusAt = (i: number) => (i === 0 || isBoundary(s[i - 1]) ? BOUNDARY_BONUS : 0);
  const table: number[][] = [];
  const best = new Array<number>(m).fill(NONE);
  let at = new Array<number>(m).fill(NONE);
  for (let i = 0; i < n; i++) {
    const next = new Array<number>(m).fill(NONE);
    for (let j = 0; j < m; j++) {
      if (s[i] !== q[j]) continue;
      if (j === 0) next[j] = bonusAt(i);
      else if ((best[j - 1] ?? NONE) !== NONE) next[j] = bonusAt(i) + Math.max(best[j - 1] ?? NONE, (at[j - 1] ?? NONE) + 1);
    }
    for (let j = 0; j < m; j++) best[j] = Math.max(best[j] ?? NONE, next[j] ?? NONE);
    table.push(next);
    at = next;
  }
  const top = best[m - 1] ?? NONE;
  if (top === NONE) return undefined;
  const pos = new Array<number>(m).fill(0);
  let i = table.findIndex((row) => row[m - 1] === top);
  pos[m - 1] = i;
  for (let j = m - 1; j > 0; j--) {
    const want = (table[i]?.[j] ?? NONE) - bonusAt(i);
    let k = i - 1;
    for (; k >= 0; k--) {
      let v = table[k]?.[j - 1] ?? NONE;
      if (v === NONE) continue;
      if (k === i - 1) v++;
      if (v === want) break;
    }
    i = k;
    pos[j - 1] = i;
  }
  return { bonus: top, pos };
}

/** Score and matched code-point positions of path against query (internal/fuzzy match); score 0: no match. */
export function fileScore(path: string, query: string): { score: number; pos: number[] } {
  if (query === "") return { score: 1, pos: [] };
  const p = lowerRunes(path);
  const q = lowerRunes(query);
  const cut = p.lastIndexOf("/") + 1;
  const base = p.slice(cut);
  const tier = (t: number, bonus: number, pos: number[]) => ({ score: t * 2 ** 20 + Math.min(bonus, 2 ** 20 - 1), pos });
  if (base.join("") === q.join("")) return tier(4, 0, q.map((_, i) => cut + i));
  if (base.join("").startsWith(q.join(""))) return tier(3, 0, q.map((_, i) => cut + i));
  const inBase = align(base, q);
  if (inBase) return tier(2, inBase.bonus, inBase.pos.map((i) => cut + i));
  const inPath = align(p, q);
  if (inPath) return tier(1, inPath.bonus, inPath.pos);
  return { score: 0, pos: [] };
}

/**
 * Go's unicode.IsSpace, which strings.Fields splits at. JavaScript's \s differs: it has
 * U+FEFF and lacks U+0085.
 */
const SPACE = /[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/;

/** internal/fuzzy Words: the query's words, split at whitespace. */
export function queryWords(query: string): string[] {
  return query.split(SPACE).filter((w) => w !== "");
}

/**
 * internal/fuzzy combine: zero when a word's score is zero, else the weakest tier, then the
 * tier sum, then the bonus sum, packed below 2^53 so a number holds it exactly.
 */
function combine(scores: Iterable<number>): number {
  let n = 0;
  let minTier = 4;
  let tiers = 0;
  let bonus = 0;
  for (const s of scores) {
    if (s === 0) return 0;
    n++;
    const tier = Math.floor(s / 2 ** 20);
    minTier = Math.min(minTier, tier);
    tiers += tier;
    bonus += s % 2 ** 20;
  }
  if (n === 0) return 1;
  return minTier * 2 ** 50 + Math.min(tiers, 2 ** 10 - 1) * 2 ** 40 + Math.min(bonus, 2 ** 40 - 1);
}

/** internal/fuzzy ScoreWords and PositionsWords: every word on its own, positions merged. */
export function wordsScore(path: string, words: readonly string[]): { score: number; pos: number[] } {
  const each = words.map((w) => fileScore(path, w));
  const score = combine(each.map((e) => e.score));
  return { score, pos: score === 0 ? [] : merge(each.map((e) => e.pos)) };
}

/** Ascending, without repeats. */
function merge(lists: readonly number[][]): number[] {
  return [...new Set(lists.flat())].sort((a, b) => a - b);
}

/** internal/fuzzy Split: words[lo:hi] on the path, the rest on the project name. */
interface Split {
  lo: number;
  hi: number;
}

/** internal/fuzzy Splits: all words on the path, then leading/trailing runs of name words. */
export function querySplits(words: readonly string[], name: string, multi: boolean): Split[] {
  const n = words.length;
  const out: Split[] = [{ lo: 0, hi: n }];
  if (!multi || n < 2) return out;
  const lname = lowerRunes(name);
  const inName = (w: string) => align(lname, lowerRunes(w)) !== undefined;
  let lead = true;
  let trail = true;
  for (let k = 1; k < n; k++) {
    lead = lead && inName(words[k - 1] ?? "");
    trail = trail && inName(words[n - k] ?? "");
    if (lead) out.push({ lo: k, hi: n });
    if (trail) out.push({ lo: 0, hi: n - k });
    if (!lead && !trail) break;
  }
  return out;
}

/** searchFiles as the router serves it: logged, then after searchMode.delayMs, failing when searchMode.fail. */
export async function searchFilesSlow(projects: ReadonlyMap<string, CompletionProject>, req: SearchRequest): Promise<SearchInit> {
  if (searchMode.delayMs > 0) await new Promise((r) => setTimeout(r, searchMode.delayMs));
  if (searchMode.fail) {
    completionCalls.push(`search ${(req.sources.length > 0 ? req.sources : [req]).map((s) => s.projectId).join(",")} ${req.query}`);
    throw new ConnectError("search failed", Code.Internal);
  }
  return searchFiles(projects, req);
}

// Go compares paths as bytes: UTF-8 length for "shorter", byte (code point) order after.
// JavaScript's .length and < count UTF-16 units, which disagree for non-ASCII paths.
const utf8 = new TextEncoder();
const byteLen = (s: string) => utf8.encode(s).length;
function cmpStr(a: string, b: string): number {
  const x = utf8.encode(a);
  const y = utf8.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return x.length - y.length;
}

export function searchFiles(projects: ReadonlyMap<string, CompletionProject>, req: SearchRequest): SearchInit {
  const { query, limit } = req;
  if (limit < 0) throw invalid(`limit ${String(limit)} is negative`);
  let named: readonly SearchSource[] = req.sources;
  if (named.length === 0) named = [{ projectId: req.projectId, path: req.path }];
  else if (req.projectId !== "" || req.path !== "") throw invalid("set sources or project_id and path, not both");
  else if (named.length > MAX_SOURCES) throw invalid(`${String(named.length)} sources, at most ${String(MAX_SOURCES)}`);
  const words = queryWords(query);
  if (words.length > MAX_WORDS) throw invalid(`query has ${String(words.length)} words, at most ${String(MAX_WORDS)}`);
  const sources: { project: CompletionProject; checkout: string }[] = [];
  for (const n of named) {
    const project = completionCheckout(projects, n.projectId, n.path);
    const checkout = n.path === "" ? project.path : clean(n.path);
    if (!sources.some((s) => s.checkout === checkout)) sources.push({ project, checkout });
  }
  completionCalls.push(`search ${sources.map((s) => s.project.id).join(",")} ${query}`);
  const depth = (p: string) => p.split("/").length;
  const hits = sources.flatMap((src, si) => {
    const splits = querySplits(words, src.project.name, sources.length > 1);
    return withParentDirs(filesByProject.get(src.project.id) ?? DEFAULT_FILES)
      .filter((e) => !req.filesOnly || !e.isDir)
      .map((e) => {
        const scores = new Map<number, number>();
        const wordScore = (w: number) => {
          let s = scores.get(w);
          if (s === undefined) {
            s = fileScore(e.path, words[w] ?? "").score;
            scores.set(w, s);
          }
          return s;
        };
        let best = { score: 0, split: splits[0] ?? { lo: 0, hi: 0 } };
        for (const sp of splits) {
          const score = combine(
            (function* () {
              for (let w = sp.lo; w < sp.hi; w++) yield wordScore(w);
            })(),
          );
          if (score > best.score) best = { score, split: sp };
        }
        return { ...e, si, src, ...best };
      })
      .filter((h) => h.score > 0);
  });
  hits.sort((a, b) =>
    (words.length === 0
      ? depth(a.path) - depth(b.path) || cmpStr(a.path, b.path)
      : b.score - a.score || byteLen(a.path) - byteLen(b.path) || cmpStr(a.path, b.path)) || a.si - b.si,
  );
  const n = Math.min(limit === 0 ? DEFAULT_FILE_LIMIT : limit, MAX_FILE_LIMIT);
  return {
    matches: hits.slice(0, n).map((h) => {
      const { lo, hi } = h.split;
      const lname = lowerRunes(h.src.project.name);
      const nameWords = [...words.slice(0, lo), ...words.slice(hi)];
      return {
        path: h.path,
        isDir: h.isDir,
        projectId: h.src.project.id,
        checkout: h.src.checkout,
        pathPositions: wordsScore(h.path, words.slice(lo, hi)).pos,
        projectPositions: merge(nameWords.map((w) => align(lname, lowerRunes(w))?.pos ?? [])),
      };
    }),
    truncated: hits.length > n,
  };
}
