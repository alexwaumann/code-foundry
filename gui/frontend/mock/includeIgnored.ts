/**
 * Include patterns for file search, as internal/fsx/include.go, internal/fsx/suggest.go and
 * internal/store/project/include.go (docs/notes/file-search-1-includes.md): the
 * files.include_ignored setting, each project's own list (ProjectService.SetIncludeIgnored
 * and the project.files.include command), the ignored files they add to SearchFiles (marked
 * `ignored`), and FilesystemService.SuggestIncludeIgnored. The rules are the daemon's in
 * small (tested in Go); the mock has no disk, so every git project has the same ignored
 * entries (IGNORED) unless a test sets its own with setMockIgnored.
 */
import { Code, ConnectError } from "@connectrpc/connect";
import { ArgType, type UiContext } from "../src/gen/codefoundry/v1/command_pb";

/** files.include_ignored's default (settings.DefaultIncludeIgnored). */
export const DEFAULT_INCLUDE_IGNORED =
  ".env*, CLAUDE.local.md, .claude/settings.local.json";
const MAX_PATTERNS = 100;
const MAX_PATTERN_LEN = 200;
const MAX_SUGGEST = 100;
const DEFAULT_SUGGEST = 20;
const COUNT_CAP = 1000;

/** One ignored entry: a file git listed, or a collapsed folder with the files under it. */
export interface MockIgnored {
  path: string;
  /** A collapsed folder: these are its files, relative to the checkout. */
  files?: string[];
}

/**
 * What every git project has ignored, unless setMockIgnored set its own (POST /__mock/files
 * sets none, so a spec with its own files sees only those).
 */
export const IGNORED: readonly MockIgnored[] = [
  { path: ".env" },
  { path: ".env.local" },
  { path: "CLAUDE.local.md" },
  { path: ".claude/settings.local.json" },
  { path: "src/.env.test" },
  {
    path: "dist",
    files: ["dist/index.js", "dist/index.js.map", "dist/assets/app.css"],
  },
  {
    path: "docs/scratch",
    files: ["docs/scratch/plan.md", "docs/scratch/ideas.md"],
  },
  {
    path: "node_modules",
    files: [
      "node_modules/react/index.js",
      "node_modules/react/package.json",
      "node_modules/dotenv/.env.example",
    ],
  },
];

const ignoredByProject = new Map<string, MockIgnored[]>();

export function setMockIgnored(
  projectId: string,
  entries: MockIgnored[],
): void {
  ignoredByProject.set(projectId, entries);
}

export function resetIgnored(): void {
  ignoredByProject.clear();
}

function ignoredOf(projectId: string): readonly MockIgnored[] {
  return ignoredByProject.get(projectId) ?? IGNORED;
}

const invalid = (msg: string) =>
  new ConnectError(`invalid argument: ${msg}`, Code.InvalidArgument);

/** checkIncludePattern's message for one trimmed pattern, or "" when it is valid. */
export function includePatternError(p: string): string {
  const bad = (why: string) => `pattern ${JSON.stringify(p)} ${why}`;
  if (p === "") return "a pattern is empty";
  if (new TextEncoder().encode(p).length > MAX_PATTERN_LEN)
    return bad(`is longer than ${String(MAX_PATTERN_LEN)} characters`);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f-\u009f]/.test(p))
    return bad("has a control character; one pattern per line");
  if (p.includes(",")) return bad("has a comma, which separates patterns");
  if (p.startsWith("!"))
    return bad(
      "starts with !: these patterns only add files, so there is nothing to exclude again",
    );
  if (p.startsWith("#"))
    return bad("starts with #, which .gitignore reads as a comment");
  if (p.startsWith("/"))
    return bad("starts with /: patterns are relative to the project folder");
  if (p === "~" || p.startsWith("~/"))
    return bad("starts with ~: patterns are relative to the project folder");
  let stars = 0;
  for (const seg of p.replace(/\/$/, "").split("/")) {
    if (seg === "") return bad("has an empty segment (//)");
    if (seg === "." || seg === "..")
      return bad(
        `has a ${JSON.stringify(seg)} segment; patterns name paths inside the project`,
      );
    if (seg === "**") stars++;
    if (globRegex(seg) === null)
      return bad("is not a valid glob (check its [ ] and \\)");
  }
  if (stars > 4) return bad("has more than 4 ** segments");
  return "";
}

/** CleanIncludePatterns: trimmed, repeats dropped, every one valid, at most 100. */
export function cleanIncludePatterns(input: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of input) {
    const p = raw.trim();
    const why = includePatternError(p);
    if (why) throw invalid(why);
    if (!out.includes(p)) out.push(p);
  }
  if (out.length > MAX_PATTERNS)
    throw invalid(
      `${String(out.length)} patterns, at most ${String(MAX_PATTERNS)}`,
    );
  return out;
}

/** fsx.CheckIncludeSetting, for the mock settings store. */
export function checkIncludeSetting(v: string): void {
  if (v.trim().toLowerCase() === "none") return;
  try {
    cleanIncludePatterns(
      v
        .split(",")
        .map((p) => p.trim())
        .filter(Boolean),
    );
  } catch (e) {
    throw new Error(
      (e as ConnectError).rawMessage.replace(/^invalid argument: /, ""),
      { cause: e },
    );
  }
}

/** fsx.SplitIncludeSetting: none or comma-separated, blanks, repeats and invalid ones dropped. */
export function splitIncludeSetting(v: string): string[] {
  if (v.trim().toLowerCase() === "none") return [];
  const out: string[] = [];
  for (const raw of v.split(",")) {
    const p = raw.trim();
    if (p !== "" && !out.includes(p) && includePatternError(p) === "")
      out.push(p);
  }
  return out;
}

/** One segment's glob ("*", "?", "[...]", "\\x") as a regex; null when malformed. */
function globRegex(seg: string): RegExp | null {
  let re = "";
  for (let i = 0; i < seg.length; i++) {
    const c = seg.charAt(i);
    if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else if (c === "\\") {
      if (i + 1 >= seg.length) return null;
      re += seg.charAt(++i).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    } else if (c === "[") {
      const end = seg.indexOf("]", i + 2);
      if (end < 0) return null;
      let body = seg.slice(i + 1, end);
      if (body.startsWith("^")) body = `\\^${body.slice(1)}`;
      re += `[${body.replace(/\\/g, "\\\\")}]`;
      i = end;
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  try {
    return new RegExp(`^${re}$`);
  } catch {
    return null;
  }
}

interface Pattern {
  segs: string[];
  dirOnly: boolean;
  anchored: boolean;
}

function compile(patterns: readonly string[]): Pattern[] {
  return patterns
    .filter((p) => includePatternError(p) === "")
    .map((p) => {
      const dirOnly = p.endsWith("/");
      const body = p.replace(/\/$/, "");
      return {
        segs: body
          .split("/")
          .filter((s, i, a) => !(s === "**" && a[i - 1] === "**")),
        dirOnly,
        anchored: body.includes("/"),
      };
    });
}

const segMatch = (pat: string, s: string) => globRegex(pat)?.test(s) ?? false;

function matchSegs(p: readonly string[], s: readonly string[]): boolean {
  if (p.length === 0) return s.length === 0;
  if (p[0] === "**") {
    const rest = p.slice(1);
    if (rest.length === 0) return s.length > 0;
    for (let i = 0; i <= s.length; i++)
      if (matchSegs(rest, s.slice(i))) return true;
    return false;
  }
  return (
    s.length > 0 &&
    segMatch(p[0] ?? "", s[0] ?? "") &&
    matchSegs(p.slice(1), s.slice(1))
  );
}

function match(p: Pattern, rel: string, isDir: boolean): boolean {
  if (p.dirOnly && !isDir) return false;
  if (!p.anchored)
    return segMatch(p.segs[0] ?? "", rel.slice(rel.lastIndexOf("/") + 1));
  return matchSegs(p.segs, rel.split("/"));
}

/** A pattern or one of rel's parent folders (as folders) matches. */
function matchUp(ps: readonly Pattern[], rel: string, isDir: boolean): boolean {
  if (ps.some((p) => match(p, rel, isDir))) return true;
  for (let i = rel.lastIndexOf("/"); i > 0; i = rel.lastIndexOf("/", i - 1)) {
    const d = rel.slice(0, i);
    if (ps.some((p) => match(p, d, true))) return true;
  }
  return false;
}

/** The pattern's leading segments name dir's, without "**", with segments left (includePattern.names). */
function names(p: Pattern, dir: string): boolean {
  if (!p.anchored) return false;
  const ds = dir.split("/");
  if (p.segs.length <= ds.length) return false;
  return ds.every((d, i) => p.segs[i] !== "**" && segMatch(p.segs[i] ?? "", d));
}

/** Files of a collapsed folder a named pattern includes: the file, or a folder of it, matches. */
function insideMatches(
  ps: readonly Pattern[],
  dir: string,
  file: string,
): boolean {
  if (ps.some((p) => match(p, file, false))) return true;
  for (
    let i = file.lastIndexOf("/");
    i > dir.length;
    i = file.lastIndexOf("/", i - 1)
  ) {
    const d = file.slice(0, i);
    if (ps.some((p) => match(p, d, true))) return true;
  }
  return false;
}

/** fsx.includedFrom over the mock's entries. */
function includedFrom(
  entries: readonly MockIgnored[],
  ps: readonly Pattern[],
): string[] {
  const out: string[] = [];
  for (const e of entries) {
    if (!e.files) {
      if (matchUp(ps, e.path, false)) out.push(e.path);
    } else if (matchUp(ps, e.path, true)) out.push(...e.files);
    else {
      const named = ps.filter((p) => names(p, e.path));
      if (named.length > 0)
        out.push(...e.files.filter((f) => insideMatches(named, e.path, f)));
    }
  }
  return out;
}

/** The ignored files a git project's search lists for these patterns (fsx.IncludedIgnored). */
export function includedIgnored(
  projectId: string,
  patterns: readonly string[],
): string[] {
  const ps = compile(patterns);
  return ps.length === 0 ? [] : includedFrom(ignoredOf(projectId), ps);
}

/** fsx.MergeIncludes: in order, without repeats. */
export function mergeIncludes(...lists: (readonly string[])[]): string[] {
  const out: string[] = [];
  for (const l of lists) for (const p of l) if (!out.includes(p)) out.push(p);
  return out;
}

/** A case-insensitive subsequence match's code-point positions, or null. */
function subsequence(path: string, query: string): number[] | null {
  const p = Array.from(path.toLowerCase());
  const q = Array.from(query.toLowerCase());
  const pos: number[] = [];
  for (let i = 0; i < p.length && pos.length < q.length; i++)
    if (p[i] === q[pos.length]) pos.push(i);
  return pos.length === q.length ? pos : null;
}

/** FilesystemService.SuggestIncludeIgnored over the mock's entries. */
export function suggestIncludeIgnored(
  projectId: string,
  git: boolean,
  effective: readonly string[],
  text: string,
  limit: number,
) {
  if (limit < 0) throw invalid(`limit ${String(limit)} is negative`);
  if (!git)
    throw new ConnectError(
      `project ${projectId} is not a git repository, so it has no ignored files`,
      Code.FailedPrecondition,
    );
  const n = Math.min(limit === 0 ? DEFAULT_SUGGEST : limit, MAX_SUGGEST);
  const entries = ignoredOf(projectId);
  const t = text.trim();
  const textError = t === "" ? "" : includePatternError(t);
  const textPats = t === "" || textError ? [] : compile([t]);
  const textFiles =
    textPats.length > 0 ? includedFrom(entries, textPats).length : 0;
  const query = t.replace(/[*?[\]\\!]/g, "").replace(/^\/+|\/+$/g, "");
  const covered = (e: MockIgnored) =>
    matchUp(textPats, e.path, !!e.files) ||
    (!!e.files && textPats.some((p) => names(p, e.path)));
  const first = textPats.length > 0 ? entries.filter(covered) : [];
  const rest = entries
    .filter((e) => !first.includes(e))
    .map((e) => ({ e, pos: subsequence(e.path, query) }))
    .filter((h) => h.pos !== null)
    .sort(
      (a, b) =>
        a.e.path.split("/").length - b.e.path.split("/").length ||
        a.e.path.length - b.e.path.length ||
        (a.e.path < b.e.path ? -1 : 1),
    );
  const picked = [
    ...first.map((e) => ({ e, pos: subsequence(e.path, query) })),
    ...rest,
  ];
  const eff = compile(effective);
  return {
    suggestions: picked.slice(0, n).map(({ e, pos }) => ({
      path: e.path,
      isDir: !!e.files,
      fileCount: Math.min(e.files?.length ?? 0, COUNT_CAP),
      fileCountCapped: (e.files?.length ?? 0) > COUNT_CAP,
      included: matchUp(eff, e.path, !!e.files),
      matchesText: matchUp(textPats, e.path, !!e.files),
      pathPositions: query === "" ? [] : (pos ?? []),
    })),
    truncated: picked.length > n,
    textFiles,
    textFilesCapped: false,
    textError,
  };
}

/** What World offers this module (mock/world.ts). */
export interface IncludeWorld {
  projectList(): { id: string; name: string; path: string }[];
  /** Sets the project's patterns and publishes projectUpdated. */
  setProjectIncludes(id: string, patterns: string[]): void;
  projectIncludes(id: string): string[];
}

/** ProjectService.SetIncludeIgnored. */
export function setIncludeIgnoredIn(
  world: IncludeWorld,
  id: string,
  patterns: readonly string[],
): string[] {
  if (!world.projectList().some((p) => p.id === id))
    throw new ConnectError(`not found: project "${id}"`, Code.NotFound);
  const clean = cleanIncludePatterns(patterns);
  world.setProjectIncludes(id, clean);
  return clean;
}

interface CommandEntry {
  cmd: {
    name: string;
    title: string;
    category: string;
    description: string;
    keybindings: string[];
    args: {
      name: string;
      type: ArgType;
      required: boolean;
      description: string;
    }[];
  };
  when: (ctx: UiContext | undefined) => boolean;
  run: (ctx: UiContext | undefined, args: Record<string, string>) => string;
}

/** project.files.include (internal/command/commands_project_include.go). */
export function includeCommands(world: IncludeWorld): CommandEntry[] {
  return [
    {
      cmd: {
        name: "project.files.include",
        title: "Include Ignored Files in Search",
        category: "Project",
        description:
          "Set the git-ignored files a project's Go to File and @ completion list too, on top of the files.include_ignored setting's: .gitignore-style patterns separated by commas (.env*, docs/scratch/), replacing the project's list; none clears it. A name never reaches inside an ignored folder that does not match itself.",
        keybindings: [],
        args: [
          {
            name: "project",
            type: ArgType.STRING,
            required: true,
            description:
              "Project id, name, or a path inside it (default: the active project)",
          },
          {
            name: "patterns",
            type: ArgType.STRING,
            required: true,
            description: "Comma-separated patterns, or none",
          },
        ],
      },
      when: (ctx) => (ctx?.activeProjectId ?? "") !== "",
      run: (ctx, args) => {
        const ref = args.project ?? ctx?.activeProjectId ?? "";
        const p = world
          .projectList()
          .find((x) => x.id === ref || x.name === ref);
        if (!p)
          throw new ConnectError(`not found: project "${ref}"`, Code.NotFound);
        const raw = args.patterns ?? "";
        const list =
          raw.trim().toLowerCase() === "none"
            ? []
            : raw
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean);
        const set = setIncludeIgnoredIn(world, p.id, list);
        return set.length > 0
          ? `project ${p.name} includes ignored files matching ${set.join(", ")}`
          : `project ${p.name} includes no ignored files of its own`;
      },
    },
  ];
}
