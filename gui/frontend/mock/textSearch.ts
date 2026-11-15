/**
 * FilesystemService.SearchText for the mock daemon, as internal/textsearch
 * (docs/notes/file-search-4-text-rpc.md): the same file set as SearchFiles (a project's mock
 * files plus the ignored files its patterns include, marked), the same query rules (literal
 * text with smart case; match case, whole word, regex), caps, cut lines, code-point ranges,
 * order (sources as sent, a source's files by path in UTF-8 byte order) and summary. Files
 * with a NUL are binary and skipped.
 *
 * Where it differs from ripgrep: a regex is a JavaScript RegExp (flag u), so syntax only Rust
 * or only JavaScript has differs, and an invalid one's message is JavaScript's; whole word is
 * a lookaround on letters, digits and "_" (\p{L}\p{N}_), close to ripgrep's Unicode \w; there
 * is no timeout (the delay control below stands in for a slow search). Contents come from
 * POST /__mock/text, else the mock disk (mock/files.ts: code-foundry's README.md and the
 * other fixtures), else DEFAULT_TEXT, else one line naming the file.
 *
 *   POST /__mock/text?project=repo-cf&path=src/a.ts&text=…   (a file's contents for text search;
 *                                                 several: repeat path= and text= pairs; reset forgets)
 *   POST /__mock/text/delay?ms=300               (each message of the stream waits this long; reset: 0)
 */
import { Code, ConnectError } from "@connectrpc/connect";
import { smartCaseSensitive } from "../src/lib/textQuery";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { SearchTextResponseSchema, TextFileMatchSchema, TextLineMatchSchema } from "../src/gen/codefoundry/v1/filesystem_pb";
import { completionCalls, resolveSources, sourceEntries, type CompletionProject, type SearchSource } from "./filesystem";

type ResponseInit = MessageInitShape<typeof SearchTextResponseSchema>;
type FileInit = MessageInitShape<typeof TextFileMatchSchema>;
type LineInit = MessageInitShape<typeof TextLineMatchSchema>;

/** textsearch.DefaultLimits, MaxQueryChars and cutContext. */
export const TEXT_LIMITS = { fileLines: 50, countLines: 999, totalLines: 2000, lineChars: 300, maxQueryChars: 500, cutContext: 40, maxSources: 16 };

/** The contents of DEFAULT_FILES (mock/filesystem.ts) when nothing else sets them. */
export const DEFAULT_TEXT: Readonly<Record<string, string>> = {
  "README.md": "# Project\n\nRun the app with `make dev`.\nSee docs/notes for decisions.\n",
  "package.json": '{\n  "name": "app",\n  "scripts": { "dev": "vite", "test": "vitest" }\n}\n',
  "src/index.ts": 'import { Composer } from "./components/Composer";\n\nexport function main(): void {\n  render(Composer);\n}\n',
  "src/components/Composer.tsx": "export function Composer() {\n  const [text, setText] = useState(\"\");\n  return <textarea value={text} onChange={(e) => setText(e.target.value)} />;\n}\n",
  "src/components/ThreadRow.tsx": "export function ThreadRow({ name }: { name: string }) {\n  return <div className=\"row\">{name}</div>;\n}\n",
  "docs/notes/x.md": "# Notes\n\nTODO: write the composer notes.\n",
  ".claude/skills/review/SKILL.md": "---\nname: review\ndescription: Review the diff against the base branch.\n---\n",
  ".claude/skills/deploy/SKILL.md": "---\nname: deploy\ndescription: Ship the current branch to staging.\n---\n",
  ".env": "API_URL=http://localhost:8080\n",
  ".env.local": "API_TOKEN=dev-token-123\n",
  "src/.env.test": "API_URL=http://localhost:9999\n",
};

/** Contents set by POST /__mock/text: project id → path → text. */
const textByProject = new Map<string, Map<string, string>>();
let delayMs = 0;

export function setMockText(projectId: string, path: string, text: string): void {
  let m = textByProject.get(projectId);
  if (!m) {
    m = new Map<string, string>();
    textByProject.set(projectId, m);
  }
  m.set(path, text);
}

export function setTextDelay(ms: number): void {
  delayMs = ms;
}

export function resetText(): void {
  textByProject.clear();
  delayMs = 0;
}

/** The SearchText request fields the mock reads. */
export interface TextSearchRequest {
  sources: readonly SearchSource[];
  query: string;
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

function invalid(msg: string): ConnectError {
  return new ConnectError(msg, Code.InvalidArgument);
}

/** textsearch.Query.CaseSensitive: match case, or an upper-case letter (in a regex, not one after a backslash). Shared with the GUI's preview. */
export function caseSensitive(text: string, matchCase: boolean, regex: boolean): boolean {
  return smartCaseSensitive(text, matchCase, regex);
}

/** An odd run of backslashes ends s. */
function trailingBackslash(s: string): boolean {
  let n = 0;
  for (let i = s.length - 1; i >= 0 && s[i] === "\\"; i--) n++;
  return n % 2 === 1;
}

/** The query as a global RegExp, or InvalidArgument as the daemon words it. */
export function compileQuery(req: Pick<TextSearchRequest, "query" | "matchCase" | "wholeWord" | "regex">): RegExp {
  const { query } = req;
  const n = Array.from(query).length;
  if (n > TEXT_LIMITS.maxQueryChars) throw invalid(`the query is ${String(n)} characters long, at most ${String(TEXT_LIMITS.maxQueryChars)}`);
  if (/[\n\r]/.test(query)) throw invalid("the query is more than one line");
  if (query.includes("\0")) throw invalid("the query holds a NUL character");
  let source = req.regex ? query : query.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  if (req.regex && trailingBackslash(query)) throw invalid("invalid regular expression: it ends with a lone \\ (write \\\\ for a backslash)");
  if (req.wholeWord) source = `(?<![\\p{L}\\p{N}_])(?:${source})(?![\\p{L}\\p{N}_])`;
  const flags = `gu${caseSensitive(query, req.matchCase, req.regex) ? "" : "i"}`;
  try {
    return new RegExp(source, flags);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw invalid(`invalid regular expression: ${msg.slice(msg.lastIndexOf(": ") + 2)}`);
  }
}

/** UTF-8 byte order, as Go compares strings. */
function byteCompare(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/** textsearch.makeLine: a line's code-point ranges, cut to lineChars around the first match. */
export function cutLine(line: string, ranges: { start: number; end: number }[], lineChars = TEXT_LIMITS.lineChars): LineInit {
  const cps = Array.from(line);
  const n = cps.length;
  if (n <= lineChars) return { text: line, ranges, cutStart: false, cutEnd: false };
  const first = ranges[0]?.start ?? 0;
  let from = Math.max(first - Math.min(TEXT_LIMITS.cutContext, Math.floor(lineChars / 3)), 0);
  from = Math.max(Math.min(from, n - lineChars), 0);
  const to = from + lineChars;
  const kept = ranges
    .filter((r) => (r.start === r.end ? r.start >= from && r.start <= to : r.start < to && r.end > from))
    .map((r) => ({ start: Math.max(r.start, from) - from, end: Math.min(r.end, to) - from }));
  return { text: cps.slice(from, to).join(""), ranges: kept, cutStart: from > 0, cutEnd: to < n };
}

/** The matches of re in one line, as code-point ranges. */
function lineRanges(re: RegExp, line: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  re.lastIndex = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const start = Array.from(line.slice(0, m.index)).length;
    out.push({ start, end: start + Array.from(m[0]).length });
    if (m[0] === "") re.lastIndex += (line.codePointAt(re.lastIndex) ?? 0) > 0xffff ? 2 : 1;
  }
  return out;
}

/**
 * SearchText's messages: one per source with files, then the summary. readDisk reads the mock
 * disk (mock/files.ts) by absolute path.
 */
export function searchTextMessages(
  projects: ReadonlyMap<string, CompletionProject>,
  req: TextSearchRequest,
  settingIncludes: readonly string[],
  readDisk: (abs: string) => string | null,
): ResponseInit[] {
  const started = Date.now();
  if (req.sources.length === 0) throw invalid("sources is required");
  if (req.sources.length > TEXT_LIMITS.maxSources) throw invalid(`${String(req.sources.length)} sources, at most ${String(TEXT_LIMITS.maxSources)}`);
  const sources = resolveSources(projects, req.sources);
  const re = compileQuery(req);
  completionCalls.push(`text ${sources.map((s) => s.project.id).join(",")} ${req.query}`);
  const sum = { lines: 0, files: 0, truncated: false, fileCapped: false, totalCapped: false, timedOut: false, caseSensitive: caseSensitive(req.query, req.matchCase, req.regex), elapsedMs: 0n };
  const out: ResponseInit[] = [];
  if (req.query !== "") {
    search: for (const src of sources) {
      const files: FileInit[] = [];
      const entries = sourceEntries(src, settingIncludes)
        .filter((e) => !e.isDir)
        .sort((a, b) => byteCompare(a.path, b.path));
      for (const e of entries) {
        const text = textByProject.get(src.project.id)?.get(e.path) ?? readDisk(`${src.checkout}/${e.path}`) ?? DEFAULT_TEXT[e.path] ?? `// ${e.path}\n`;
        if (text.includes("\0")) continue;
        const lines: LineInit[] = [];
        let count = 0;
        const all = text.split("\n");
        if (all.at(-1) === "") all.pop();
        for (const [i, raw] of all.entries()) {
          const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
          const ranges = lineRanges(re, line);
          if (ranges.length === 0) continue;
          count++;
          if (lines.length < TEXT_LIMITS.fileLines) lines.push({ line: i + 1, ...cutLine(line, ranges) });
          if (count > TEXT_LIMITS.countLines) break;
        }
        if (lines.length === 0) continue;
        const room = TEXT_LIMITS.totalLines - sum.lines;
        if (room <= 0) {
          sum.totalCapped = true;
          break;
        }
        if (count > lines.length) sum.fileCapped = true;
        if (lines.length > room) {
          lines.length = room;
          sum.totalCapped = true;
        }
        files.push({
          projectId: src.project.id,
          checkout: src.checkout,
          path: e.path,
          ignored: e.ignored,
          lines,
          lineCount: Math.min(count, TEXT_LIMITS.countLines),
          lineCountCapped: count > TEXT_LIMITS.countLines,
        });
        sum.files++;
        sum.lines += lines.length;
      }
      if (files.length > 0) out.push({ files });
      if (sum.totalCapped || sum.lines >= TEXT_LIMITS.totalLines) {
        sum.totalCapped ||= src !== sources.at(-1);
        break search;
      }
    }
  }
  sum.truncated = sum.fileCapped || sum.totalCapped || sum.timedOut;
  sum.elapsedMs = BigInt(Date.now() - started);
  out.push({ summary: sum });
  return out;
}

/** The stream: searchTextMessages, each after the delay control's wait; it ends when signal aborts. */
export async function* searchText(
  projects: ReadonlyMap<string, CompletionProject>,
  req: TextSearchRequest,
  settingIncludes: readonly string[],
  readDisk: (abs: string) => string | null,
  signal: AbortSignal,
): AsyncGenerator<ResponseInit> {
  const messages = searchTextMessages(projects, req, settingIncludes, readDisk);
  for (const m of messages) {
    if (delayMs > 0) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, delayMs);
        signal.addEventListener("abort", () => {
          clearTimeout(t);
          resolve();
        }, { once: true });
      });
    }
    if (signal.aborted) return;
    yield m;
  }
}
