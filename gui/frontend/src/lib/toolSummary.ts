/**
 * What a thread's tool row says (docs/sketches/rendered-thread, variant A): a verb
 * and a target ("Read fingerprint.go internal/store/pr", "Ran go test ./…"), meta on the
 * right ("84 lines", "+6 −1", "5 matches") and a chip for a command's outcome ("ok",
 * "exit 1"). Tense follows the call: "Run" while it waits for permission, "Running" while it
 * runs, "Ran" once done. Pure; inputs are parsed tolerantly (a streaming input is partial JSON).
 */
import type { ToolCallView } from "@/api/thread";
import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from "@pierre/diffs";

export type Json = Record<string, unknown>;

/** The JSON object in `s`, or {} (partial JSON while streaming, an array, junk). */
export function parseObject(s: string): Json {
  if (!s) return {};
  try {
    const v: unknown = JSON.parse(s);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
  } catch {
    return {};
  }
}

export function str(o: Json, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

export function num(o: Json, key: string): number | null {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function obj(o: Json, key: string): Json {
  const v = o[key];
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

/** "a/b/c.go" → ["c.go", "a/b"]; the dir relative to `cwd` when it is inside it. */
export function splitPath(path: string, cwd = ""): { base: string; dir: string } {
  const root = cwd.replace(/\/+$/, "");
  const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
  const i = rel.lastIndexOf("/");
  return i < 0 ? { base: rel, dir: "" } : { base: rel.slice(i + 1), dir: rel.slice(0, i) };
}

/** A path relative to cwd when inside it. */
export function relPath(path: string, cwd = ""): string {
  const { base, dir } = splitPath(path, cwd);
  return dir ? `${dir}/${base}` : base;
}

export type Tense = "pending" | "running" | "done";

export type ChipTone = "ok" | "fail" | "muted";

export interface ToolSummary {
  /** "Ran", "Read", "Edited", "Agent", ... */
  verb: string;
  /** The main object, bold (a file name, a pattern, a description) or mono (a command). */
  target: string;
  targetStyle: "bold" | "mono" | "plain";
  /** Muted text after the target (a directory, "in internal/", the subagent type). */
  detail: string;
  detailMono: boolean;
  /** Right-aligned muted text ("84 lines", "5 matches", "4 tools · 41s"). */
  meta: string;
  /** Lines added / removed (Edit, Write). */
  added: number;
  removed: number;
  chip: { tone: ChipTone; text: string } | null;
}

const VERBS: Readonly<Record<string, readonly [string, string, string]>> = {
  // pending, running, done
  Bash: ["Run", "Running", "Ran"],
  Read: ["Read", "Reading", "Read"],
  Edit: ["Edit", "Editing", "Edited"],
  MultiEdit: ["Edit", "Editing", "Edited"],
  NotebookEdit: ["Edit", "Editing", "Edited"],
  Write: ["Write", "Writing", "Wrote"],
  Grep: ["Search for", "Searching for", "Searched for"],
  Glob: ["Find", "Finding", "Found"],
  LS: ["List", "Listing", "Listed"],
  WebFetch: ["Fetch", "Fetching", "Fetched"],
  WebSearch: ["Search the web for", "Searching the web for", "Searched the web for"],
  TodoWrite: ["Update todos", "Updating todos", "Updated todos"],
  Agent: ["Agent", "Agent", "Agent"],
  Task: ["Agent", "Agent", "Agent"],
};

function verbOf(name: string, tense: Tense): string {
  const v = VERBS[name];
  if (!v) return name;
  return tense === "pending" ? v[0] : tense === "running" ? v[1] : v[2];
}

/** "0.9s", "41s", "4m 08s"; "" under 50 ms. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 50) return "";
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${String(Math.floor(m / 60))}h ${String(m % 60).padStart(2, "0")}m`;
}

/** A Bash call's exit code from its result text ("Exit code 1\n…"), 0 when it succeeded, null when unknown. */
export function exitCode(t: Pick<ToolCallView, "isError" | "output" | "status">): number | null {
  if (t.status === "running" || t.status === "unknown") return null;
  if (!t.isError) return 0;
  const m = /^Exit code (\d+)/.exec(t.output);
  return m ? Number(m[1]) : null;
}

/** The first line of a command, for one row. */
export function firstLine(s: string): string {
  const line = s.split("\n")[0] ?? "";
  return s.includes("\n") ? `${line} …` : line;
}

/** One hunk of Claude's structuredPatch (the `diff` package's format). */
export interface StructuredPatchHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** " ctx", "-del", "+add", "\\ No newline at end of file". */
  lines: readonly string[];
}

/** One old → new pair of an input-built diff; `oldText` null for a file (or cell) that is all new. */
export interface ContentPair {
  oldText: string | null;
  newText: string;
}

/**
 * What an Edit, MultiEdit, Write or NotebookEdit row's diff renders from
 * (components/code/CodeDiff): Claude's structuredPatch as a unified patch (real line
 * numbers), or old/new contents from the input. `numbered` is false for snippets whose
 * place in the file is unknown (an Edit's old_string / new_string, a notebook cell), so
 * their line numbers are not shown. `name` is the file name the language comes from.
 */
export type ToolDiff =
  | { kind: "patch"; path: string; patch: string }
  | { kind: "contents"; path: string; name: string; pairs: readonly ContentPair[]; numbered: boolean };

/** Claude's structuredPatch as a git-style unified patch for one file. */
export function structuredPatchText(path: string, hunks: readonly StructuredPatchHunk[]): string {
  const p = path.replace(/^\/+/, "");
  const out = [`diff --git a/${p} b/${p}`, `--- a/${p}`, `+++ b/${p}`];
  for (const h of hunks) {
    out.push(`@@ -${String(h.oldStart)},${String(h.oldLines)} +${String(h.newStart)},${String(h.newLines)} @@`);
    out.push(...h.lines);
  }
  return `${out.join("\n")}\n`;
}

function endLine(s: string): string {
  return s === "" || s.endsWith("\n") ? s : `${s}\n`;
}

/** The language name for a notebook cell (its result's language when Claude sent one). */
function cellName(input: Json, result: Json): string {
  if (str(input, "cell_type") === "markdown") return "cell.md";
  const lang = str(result, "language").toLowerCase();
  return lang === "" || lang === "python" ? "cell.py" : `cell.${lang}`;
}

/** The diff a file-changing tool shows: the result's structuredPatch first, else built from the input; null when there is none. */
export function toolDiff(t: Pick<ToolCallView, "name" | "inputJson" | "resultJson">): ToolDiff | null {
  const input = parseObject(t.inputJson);
  const result = parseObject(t.resultJson);
  const path = str(input, "file_path") || str(input, "notebook_path");
  const name = path.slice(path.lastIndexOf("/") + 1) || "file";
  const patch = result.structuredPatch;
  if (Array.isArray(patch) && patch.length > 0) return { kind: "patch", path, patch: structuredPatchText(path || "file", patch as StructuredPatchHunk[]) };
  const contents = (pairs: ContentPair[], numbered: boolean, n = name): ToolDiff | null => {
    const changed = pairs
      // A snippet (unnumbered) has no end of file: end its lines so none reads "No newline at end of file".
      .map((p) => (numbered ? p : { oldText: p.oldText === null ? null : endLine(p.oldText), newText: endLine(p.newText) }))
      .filter((p) => p.oldText !== p.newText && (p.oldText !== null || p.newText !== ""));
    return changed.length > 0 ? { kind: "contents", path, name: n, pairs: changed, numbered } : null;
  };
  switch (t.name) {
    case "Edit":
      return contents([{ oldText: str(input, "old_string"), newText: str(input, "new_string") }], false);
    case "MultiEdit": {
      const edits = Array.isArray(input.edits) ? (input.edits as Json[]) : [];
      return contents(
        edits.map((e) => ({ oldText: str(e, "old_string"), newText: str(e, "new_string") })),
        false,
      );
    }
    case "Write":
      // An update that changed nothing has an empty patch: no diff. Otherwise (a new file,
      // or no result yet) the content shows as added.
      if (str(result, "type") === "update") return null;
      return contents([{ oldText: null, newText: str(input, "content") }], true);
    case "NotebookEdit":
      // The cell's old source is not in the input: a replaced or inserted cell shows as added.
      if (str(input, "edit_mode") === "delete") return null;
      return contents([{ oldText: null, newText: str(input, "new_source") }], false, cellName(input, result));
    default:
      return null;
  }
}

/** The library's diff metadata for each part of a tool diff (one per pair; one for a patch). */
export function toolDiffFiles(d: ToolDiff): FileDiffMetadata[] {
  if (d.kind === "patch") return parsePatchFiles(d.patch).flatMap((p) => p.files);
  return d.pairs.map((p) => parseDiffFromFile(p.oldText === null ? null : { name: d.name, contents: p.oldText }, { name: d.name, contents: p.newText }));
}

/** Added and removed line counts. */
export function diffStats(files: readonly FileDiffMetadata[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const f of files) {
    for (const h of f.hunks) {
      added += h.additionLines;
      removed += h.deletionLines;
    }
  }
  return { added, removed };
}

const statsCache = new WeakMap<object, { added: number; removed: number }>();

/** A tool call's diff stats, computed once per call object (rows render it twice per update). */
export function toolDiffStats(t: Pick<ToolCallView, "name" | "inputJson" | "resultJson">): { added: number; removed: number } {
  let s = statsCache.get(t);
  if (!s) {
    const d = toolDiff(t);
    s = d ? diffStats(toolDiffFiles(d)) : { added: 0, removed: 0 };
    statsCache.set(t, s);
  }
  return s;
}

const chomp = (l: string | undefined) => (l ?? "").replace(/\r?\n$/, "");

/** A tool diff as unified text, for Copy: the patch itself, or each pair's hunks ("@@" alone when unnumbered). */
export function diffText(d: ToolDiff, files: readonly FileDiffMetadata[]): string {
  if (d.kind === "patch") return d.patch;
  const out: string[] = [];
  for (const f of files) {
    for (const h of f.hunks) {
      out.push(d.numbered ? `@@ -${String(h.deletionStart)},${String(h.deletionCount)} +${String(h.additionStart)},${String(h.additionCount)} @@` : "@@");
      for (const c of h.hunkContent) {
        if (c.type === "context") {
          for (let i = 0; i < c.lines; i++) out.push(` ${chomp(f.additionLines[c.additionLineIndex + i])}`);
        } else {
          for (let i = 0; i < c.deletions; i++) out.push(`-${chomp(f.deletionLines[c.deletionLineIndex + i])}`);
          for (let i = 0; i < c.additions; i++) out.push(`+${chomp(f.additionLines[c.additionLineIndex + i])}`);
        }
      }
    }
  }
  return out.join("\n");
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${String(n)} ${n === 1 ? one : many}`;
}

/** The row for a tool call. `cwd` shortens paths inside the thread's worktree. */
export function toolSummary(t: ToolCallView, opts: { tense: Tense; durationMs?: number; cwd?: string }): ToolSummary {
  const input = parseObject(t.inputJson);
  const result = parseObject(t.resultJson);
  const cwd = opts.cwd ?? "";
  const s: ToolSummary = { verb: verbOf(t.name, opts.tense), target: "", targetStyle: "bold", detail: "", detailMono: true, meta: "", added: 0, removed: 0, chip: null };
  const done = opts.tense === "done";
  const duration = done && opts.durationMs !== undefined ? formatDuration(opts.durationMs) : "";
  switch (t.name) {
    case "Bash": {
      s.target = firstLine(str(input, "command"));
      s.targetStyle = "mono";
      const code = exitCode(t);
      if (done && t.status !== "running") {
        if (code === 0) s.chip = { tone: "ok", text: "ok" };
        else if (code !== null) s.chip = { tone: "fail", text: `exit ${String(code)}` };
        else if (t.isError) s.chip = { tone: "fail", text: "error" };
      }
      s.meta = duration;
      break;
    }
    case "Read": {
      const path = str(input, "file_path");
      const { base, dir } = splitPath(path, cwd);
      s.target = base;
      s.detail = dir;
      const file = obj(result, "file");
      if (str(result, "type") === "image") s.meta = "image";
      else {
        const lines = num(file, "numLines");
        if (lines !== null) s.meta = plural(lines, "line");
      }
      break;
    }
    case "Edit":
    case "MultiEdit":
    case "Write":
    case "NotebookEdit": {
      const path = str(input, "file_path") || str(input, "notebook_path");
      const { base, dir } = splitPath(path, cwd);
      s.target = base;
      s.detail = dir;
      if (t.name === "Write" && done && str(result, "type") === "create") s.verb = "Created";
      const stats = toolDiffStats(t);
      s.added = stats.added;
      s.removed = stats.removed;
      // The diff shows one occurrence; say it applied to every one.
      if (input.replace_all === true) s.meta = "every occurrence";
      break;
    }
    case "Grep": {
      s.target = str(input, "pattern");
      s.targetStyle = "mono";
      const where = str(input, "path") || str(input, "glob");
      s.detail = where ? `in ${relPath(where, cwd)}` : "";
      const matches = num(result, "numMatches") ?? (str(result, "mode") === "content" ? num(result, "numLines") : null);
      const files = num(result, "numFiles");
      if (matches !== null) s.meta = plural(matches, "match", "matches");
      else if (files !== null) s.meta = plural(files, "file");
      break;
    }
    case "Glob": {
      s.target = str(input, "pattern");
      s.targetStyle = "mono";
      const where = str(input, "path");
      s.detail = where ? `in ${relPath(where, cwd)}` : "";
      const files = num(result, "numFiles");
      if (files !== null) s.meta = plural(files, "file");
      break;
    }
    case "LS":
      s.target = relPath(str(input, "path"), cwd) || ".";
      s.targetStyle = "mono";
      break;
    case "Agent":
    case "Task": {
      s.target = str(input, "description") || "Subagent";
      s.detail = str(input, "subagent_type");
      s.detailMono = false;
      const tools = num(result, "totalToolUseCount");
      const ms = num(result, "totalDurationMs");
      s.meta = [tools !== null ? plural(tools, "tool") : "", ms !== null ? formatDuration(ms) : ""].filter(Boolean).join(" · ");
      break;
    }
    case "WebFetch":
      s.target = str(input, "url").replace(/^https?:\/\//, "");
      s.targetStyle = "mono";
      break;
    case "WebSearch":
      s.target = str(input, "query");
      break;
    case "TodoWrite": {
      const todos = Array.isArray(input.todos) ? (input.todos as Json[]) : [];
      if (todos.length > 0) s.meta = `${String(todos.filter((x) => str(x, "status") === "completed").length)}/${String(todos.length)} done`;
      break;
    }
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(t.name);
      if (mcp) {
        s.verb = opts.tense === "pending" ? "Use" : "Used";
        s.target = mcp[2] ?? t.name;
        s.detail = mcp[1] ?? "";
        s.detailMono = false;
      } else {
        // The first string argument says what the call is about.
        const first = Object.values(input).find((v): v is string => typeof v === "string" && v.length > 0) ?? "";
        s.target = firstLine(first);
        s.targetStyle = "plain";
      }
      s.meta = duration;
    }
  }
  if (t.isError && !s.chip && done) s.chip = { tone: "fail", text: "error" };
  return s;
}

/** What a subagent reported back: the result's text blocks, else the tool output. */
export function agentReport(t: Pick<ToolCallView, "resultJson" | "output">): string {
  const content = parseObject(t.resultJson).content;
  if (Array.isArray(content)) {
    const text = (content as Json[]).map((c) => str(c, "text")).join("\n\n").trim();
    if (text) return text;
  }
  return t.output.replace(/^\[Subagent hand-back\][^\n]*\n+/, "").trim();
}

