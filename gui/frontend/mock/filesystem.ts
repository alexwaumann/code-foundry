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

// ---- composer completion: ListSkills and SearchFiles -------------------------------------
//
// Every project has the same small file list unless a test sets its own
// (POST /__mock/files?project=repo-cf&path=a.ts&path=src/b.ts; no path: an empty project), and
// the project skills `review` and `deploy`; the user has `commit`. Ranking mirrors
// internal/fuzzy: exact base name > base name prefix > base name subsequence > path
// subsequence, then shorter path, then path; an empty query lists the shallowest first.

/** A project the completion RPCs can see: its id and main worktree (world.ts MockProject). */
export interface CompletionProject {
  id: string;
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

function isSubsequence(s: string, q: string): boolean {
  let j = 0;
  for (let i = 0; i < s.length && j < q.length; i++) if (s[i] === q[j]) j++;
  return j === q.length;
}

/** 4 exact base name, 3 base prefix, 2 base subsequence, 1 path subsequence, 0 none. */
export function fileTier(path: string, query: string): number {
  if (query === "") return 1;
  const p = path.toLowerCase();
  const q = query.toLowerCase();
  const base = p.slice(p.lastIndexOf("/") + 1);
  if (base === q) return 4;
  if (base.startsWith(q)) return 3;
  if (isSubsequence(base, q)) return 2;
  return isSubsequence(p, q) ? 1 : 0;
}

/** searchFiles as the router serves it: logged, then after searchMode.delayMs, failing when searchMode.fail. */
export async function searchFilesSlow(projects: ReadonlyMap<string, CompletionProject>, projectId: string, path: string, query: string, limit: number): Promise<SearchInit> {
  if (searchMode.delayMs > 0) await new Promise((r) => setTimeout(r, searchMode.delayMs));
  if (searchMode.fail) {
    completionCalls.push(`search ${projectId} ${query}`);
    throw new ConnectError("search failed", Code.Internal);
  }
  return searchFiles(projects, projectId, path, query, limit);
}

export function searchFiles(projects: ReadonlyMap<string, CompletionProject>, projectId: string, path: string, query: string, limit: number): SearchInit {
  if (limit < 0) throw invalid(`limit ${String(limit)} is negative`);
  const project = completionCheckout(projects, projectId, path);
  completionCalls.push(`search ${project.id} ${query}`);
  const q = query.trim();
  const depth = (p: string) => p.split("/").length;
  const ranked = withParentDirs(filesByProject.get(project.id) ?? DEFAULT_FILES)
    .map((e) => ({ ...e, tier: fileTier(e.path, q) }))
    .filter((e) => e.tier > 0)
    .sort((a, b) =>
      q === ""
        ? depth(a.path) - depth(b.path) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
        : b.tier - a.tier || a.path.length - b.path.length || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
  const n = Math.min(limit === 0 ? DEFAULT_FILE_LIMIT : limit, MAX_FILE_LIMIT);
  return { matches: ranked.slice(0, n).map(({ path, isDir }) => ({ path, isDir })), truncated: ranked.length > n };
}
