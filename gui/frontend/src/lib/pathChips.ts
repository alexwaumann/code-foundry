/**
 * Path chips (docs/notes/file-viewer-4-chips.md): which tokens in Claude's markdown are file
 * paths that open the File tab, and where they point. Pure.
 *
 * A token is a candidate in two places, with two strictnesses:
 *
 * - **code**: a whole inline code span (`src/a.ts:12`). Generous: the author marked it.
 * - **prose**: a whitespace-separated word of a text node outside code, pre and links, with
 *   leading `([{"'` and trailing `.,;:!?)]}"'` stripped. Strict: a sentence is full of
 *   slashes that are not paths ("and/or", "client/server").
 *
 * Either way the token is one path, optionally followed by `:line`, `:line:col` or
 * `:line-line` (a range opens at its first line). A path with spaces (`docs/my report.pdf`)
 * can only be told from the words around it when something delimits it, so it is a
 * candidate in a code span, in prose between quotes (`"docs/my report.pdf"`, curly ones
 * too), or as a prose line that is nothing but the path (Claude's "one per line" lists);
 * it then has to pass more rules (spacedPathOk: a file with a known extension, no words
 * that read as a command). A bare one inside a sentence ("saved to /a/my report.pdf now")
 * is not chipped, and neither are its pieces: `/a/my` and `report.pdf` would open the
 * wrong files. A token is rejected when it:
 *
 * - has `://` (a URL) or starts with a domain-looking segment (`github.com/a/b`);
 * - starts with `-` (a flag), `@` (a scoped package, a decorator) or `$`;
 * - has a character a path in prose does not ("*?[]{}()<>|&;=,$`'\"\\#", whitespace other
 *   than a spaced path's single spaces; a spaced path may have balanced parentheses):
 *   globs, shell, code;
 * - has no letter (`1/2`, `10/17/2026`), is only `/`, `~`, `~/`, `.`, `..`, or has a `...`
 *   segment (Go's `./...`).
 *
 * Then it must look like a path:
 *
 * | | code | prose |
 * | --- | --- | --- |
 * | absolute `/…` | two or more segments, or a known extension (`/compact` is a slash command) | same |
 * | `~/…`, `./…`, `../…` | yes | yes |
 * | relative with a known extension or name (`README.md`, `Makefile`) | yes | yes |
 * | relative, a trailing slash (`docs/`) | yes (a folder: the File tab says so) | two or more segments |
 * | relative, no extension | a `/` in it, unless it reads as a git ref (`origin/main`, `cf/x`) or a MIME type | three or more segments |
 *
 * A bare name (no slash) also skips `Node.js`-style names (a capitalized stem with `.js`).
 * Known extensions are EXTENSIONS: the code, config, prose, image and archive types the
 * thread's highlighter (lib/highlight) and the File tab's kinds (components/files/fileKind)
 * know, minus ones that read as words or members (`console.log`, `.r`, `.m`).
 */
import { resolvePath } from "./filePath";

/** A detected path: as typed (without the line suffix), and its line and column. */
export interface PathMatch {
  /** The whole token as it appears, suffix included ("src/a.ts:12"). */
  text: string;
  path: string;
  line?: number;
  col?: number;
}

export type PathContext = "code" | "prose";

const EXTENSIONS: ReadonlySet<string> = new Set([
  // code
  "ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs", "go", "py", "pyi", "rb", "rs", "java", "kt", "kts", "scala", "swift",
  "c", "h", "cc", "cpp", "cxx", "hpp", "hh", "cs", "fs", "lua", "pl", "php", "dart", "ex", "exs", "erl", "hs", "ml", "clj",
  "elm", "zig", "nim", "sh", "bash", "zsh", "fish", "ps1", "sql", "proto", "graphql", "gql", "vue", "svelte", "astro", "wasm",
  "ipynb", "tmpl", "gotmpl", "tf", "hcl", "nix", "gradle", "mk", "cmake",
  // web and config
  "html", "htm", "css", "scss", "sass", "less", "json", "jsonc", "json5", "yaml", "yml", "toml", "ini", "cfg", "conf", "env",
  "xml", "plist", "lock", "mod", "sum", "csv", "tsv", "patch", "diff",
  // prose
  "md", "mdx", "markdown", "txt", "rst", "adoc",
  // media and archives
  "png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "icns", "pdf", "zip", "gz", "tgz", "tar", "dmg",
]);

/** File names without a (known) extension that are files all the same. */
const NAMES: ReadonlySet<string> = new Set([
  "Makefile", "makefile", "Dockerfile", "Justfile", "Gemfile", "Rakefile", "Procfile", "Brewfile", "LICENSE", "CODEOWNERS",
  ".gitignore", ".gitattributes", ".gitmodules", ".editorconfig", ".npmrc", ".nvmrc", ".env", ".envrc", ".zshrc", ".bashrc",
  ".profile", ".prettierrc", ".eslintrc",
]);

/** First segments of a one-slash token that make it a git ref, not a folder: `origin/main`, `cf/<slug>` (the app's branches). */
const REF_HEADS: ReadonlySet<string> = new Set(["origin", "upstream", "refs", "heads", "remotes", "tags", "cf", "feat", "fix", "chore"]);

/** MIME top-level types (`application/json`, `text/plain`). */
const MIME_HEADS: ReadonlySet<string> = new Set(["application", "text", "image", "audio", "video", "font", "multipart", "message"]);

const SUFFIX = /:(\d+)(?:[:-](\d+))?$/;
const PATH_CHARS = /^[\p{L}\p{N}_.\-+@~/%]+$/u;
/** A spaced path's characters: a path's, its spaces (macOS puts U+202F before "AM" in screenshot names), and parentheses ("report (1).pdf"). */
const SPACED_CHARS = /^[\p{L}\p{N}_.\-+@~/%() \u00a0\u202f]+$/u;
/** The spaces a spaced path may have, one at a time. */
const SPACE = /[ \u00a0\u202f]/;
const LETTER = /\p{L}/u;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function hasKnownExtension(name: string): boolean {
  if (NAMES.has(name)) return true;
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return false;
  return EXTENSIONS.has(name.slice(i + 1).toLowerCase());
}

/** Whether parentheses open and close in order ("report (1).pdf"), none nested. */
function balancedParens(s: string): boolean {
  let open = false;
  for (const c of s) {
    if (c === "(") {
      if (open) return false;
      open = true;
    } else if (c === ")") {
      if (!open) return false;
      open = false;
    }
  }
  return !open;
}

/**
 * Whether a path with spaces may be one (the rest of matchPath's rules still apply). Only
 * a delimited token can have spaces (a code span, a quoted span, a line that is only the
 * path), and it is held to more: one space at a time, no space at either end; a known
 * extension (a file, not a folder: `npm run build` is not); no word after the first that
 * starts like a flag, a variable or another path (`/bin/cat /tmp/a b.md`), and no word
 * before the last that is a file already (`src/a.ts and src/b.ts`); a relative path has a
 * slash and no space before its first one (`cat docs/a.md`, `open shots/x.png` are
 * commands), so a bare name (`screen shot.png`) is not one.
 */
function spacedPathOk(path: string): boolean {
  if (!SPACED_CHARS.test(path) || !balancedParens(path)) return false;
  if (SPACE.test(path.charAt(0)) || SPACE.test(path.charAt(path.length - 1)) || /[ \u00a0\u202f]{2}/.test(path)) return false;
  const words = path.split(SPACE);
  if (words.slice(1).some((w) => /^[-/~$@]/.test(w))) return false;
  if (words.slice(0, -1).some((w) => hasKnownExtension(w.slice(w.lastIndexOf("/") + 1)))) return false;
  if (path.endsWith("/") || !hasKnownExtension(path.slice(path.lastIndexOf("/") + 1))) return false;
  if (/^(\/|~\/|\.\.?\/)/.test(path)) return true;
  const slash = path.indexOf("/");
  return slash > 0 && !SPACE.test(path.slice(0, slash));
}

/** The token as a path chip, or null. */
export function matchPath(token: string, where: PathContext): PathMatch | null {
  if (token.length < 2 || token.length > 400) return null;
  let path = token;
  let line: number | undefined;
  let col: number | undefined;
  const m = SUFFIX.exec(path);
  if (m) {
    path = path.slice(0, m.index);
    line = Number(m[1]);
    // `:12:5` is a column, `:12-30` a range: the first line either way.
    if (m[2] !== undefined && m[0].charAt((m[1] ?? "").length + 1) === ":") col = Number(m[2]);
    if (!Number.isSafeInteger(line) || line <= 0) return null;
  }
  if (SPACE.test(path) ? !spacedPathOk(path) : !PATH_CHARS.test(path)) return null;
  if (!LETTER.test(path)) return null;
  if (path.includes("://") || /^[-@$]/.test(path)) return null;
  if (path === "~" || path === "." || path === ".." || /^\/+$/.test(path)) return null;
  const dir = path.endsWith("/");
  const segments = path.split("/").filter((s) => s !== "");
  // Go's `./...` and the like: patterns, not files.
  if (segments.length === 0 || segments.some((s) => /^\.{3,}$/.test(s))) return null;
  const name = segments[segments.length - 1] ?? "";
  const known = !dir && hasKnownExtension(name);
  const match = (): PathMatch => ({ text: token, path, ...(line !== undefined && { line }), ...(col !== undefined && { col }) });

  if (path.startsWith("~/") || path.startsWith("./") || path.startsWith("../")) return segments.length > 1 ? match() : null;
  if (path.startsWith("/")) return segments.length >= 2 || known ? match() : null;

  // Relative from here on.
  const head = segments[0] ?? "";
  if (segments.length > 1 && head.includes(".") && DOMAIN.test(head) && !hasKnownExtension(head)) return null;
  if (!path.includes("/")) {
    if (!known) return null;
    // Node.js, Next.js, Three.js: names, not files.
    if (/^[A-Z][^.]*\.js$/.test(name)) return null;
    return match();
  }
  if (known) return match();
  if (where === "prose") return (dir && segments.length >= 2) || (!dir && segments.length >= 3) ? match() : null;
  if (dir) return match();
  if (segments.length === 2 && (REF_HEADS.has(head) || MIME_HEADS.has(head))) return null;
  return match();
}

/** Leading and trailing punctuation a prose word sheds before it is matched. */
const LEAD = /^[([{"'“‘«]+/;
const TRAIL = /[.,;:!?)\]}"'”’»]+$/;

/** A run of a text node: plain text, or a path chip. */
export type ProsePiece = string | PathMatch;

/** A stretch of a text node already decided: a chip, or (null) text no word in it may chip. */
interface Span {
  start: number;
  end: number;
  hit: PathMatch | null;
}

/** Quote pairs a spaced prose path may sit between (the quotes stay text). */
const QUOTED = /(?<![\p{L}\p{N}])(?:"([^"\n]+)"|“([^“”\n]+)”|‘([^‘’\n]+)’|'([^'\n]+)')(?![\p{L}\p{N}])/gu;

/** Quoted spaced paths: the path between the quotes, trailing punctuation inside them left out (`“docs/my report.pdf.”`). */
function quotedSpans(text: string): Span[] {
  const out: Span[] = [];
  for (const q of text.matchAll(QUOTED)) {
    const inner = q[1] ?? q[2] ?? q[3] ?? q[4] ?? "";
    if (!SPACE.test(inner)) continue; // a word: the word pass has it
    const core = inner.slice(0, inner.length - (TRAIL.exec(inner)?.[0].length ?? 0));
    const hit = matchPath(core, "prose");
    const start = q.index + 1;
    if (hit) out.push({ start, end: start + core.length, hit });
  }
  return out;
}

/** The most words a bare spaced path is looked for across ("Screenshot 2026-10-18 at 10.42.13 AM.png" is five). */
const RUN_WORDS = 6;

/**
 * Bare spaced paths in [from, to): a word with a slash and the words after it (single
 * spaces apart) up to the first that ends in a known extension, when together they pass
 * as a spaced path. Alone on its line (leading `([{"'`, trailing punctuation aside) the
 * run is a chip; inside a sentence it is only kept from the word pass, whose pieces of it
 * would be wrong.
 */
function runSpans(text: string, from: number, to: number): Span[] {
  const out: Span[] = [];
  const words = [...text.slice(from, to).matchAll(/\S+/g)].map((w) => ({ start: from + w.index, end: from + w.index + w[0].length }));
  for (let i = 0; i < words.length; i++) {
    const first = words[i];
    if (!first) continue;
    const word = text.slice(first.start, first.end);
    if (!word.includes("/")) continue;
    const start = first.start + (LEAD.exec(word)?.[0].length ?? 0);
    for (let j = i + 1; j < words.length && j < i + RUN_WORDS; j++) {
      const w = words[j];
      const prev = words[j - 1];
      if (!w || !prev || w.start - prev.end !== 1 || !SPACE.test(text.charAt(prev.end))) break;
      const last = text.slice(w.start, w.end);
      const lastCore = last.slice(0, last.length - (TRAIL.exec(last)?.[0].length ?? 0)).replace(SUFFIX, "");
      if (!hasKnownExtension(lastCore.slice(lastCore.lastIndexOf("/") + 1))) continue;
      const end = w.end - (TRAIL.exec(last)?.[0].length ?? 0);
      const hit = matchPath(text.slice(start, end), "prose");
      if (hit) {
        const lineStart = text.lastIndexOf("\n", start - 1) + 1;
        const nl = text.indexOf("\n", end);
        const lineEnd = nl < 0 ? text.length : nl;
        const alone = /^\s*[([{"'“‘«]*$/.test(text.slice(lineStart, start)) && /^[.,;:!?)\]}"'”’»]*\s*$/.test(text.slice(end, lineEnd));
        out.push(alone ? { start, end, hit } : { start: first.start, end: w.end, hit: null });
        i = j;
      }
      break;
    }
  }
  return out;
}

/** The chips among the whitespace-separated words of [from, to), into out. */
function wordChips(text: string, from: number, to: number, out: Span[]): void {
  for (const w of text.slice(from, to).matchAll(/\S+/g)) {
    const word = w[0];
    const lead = LEAD.exec(word)?.[0].length ?? 0;
    let core = word.slice(lead);
    const trail = TRAIL.exec(core)?.[0] ?? "";
    // A trailing ":12" survives: only punctuation after the digits goes.
    core = core.slice(0, core.length - trail.length);
    const hit = core ? matchPath(core, "prose") : null;
    if (!hit) continue;
    const start = from + w.index + lead;
    out.push({ start, end: start + core.length, hit });
  }
}

/** Calls fn for each stretch of [from, to) not covered by spans (sorted, apart). */
function gaps(spans: readonly Span[], from: number, to: number, fn: (a: number, b: number) => void): void {
  let at = from;
  for (const s of spans) {
    if (s.start > at) fn(at, s.start);
    at = Math.max(at, s.end);
  }
  if (at < to) fn(at, to);
}

/**
 * A prose text split into text and path chips, or null when it has none (the common case:
 * callers keep the original node). Whitespace, quotes and stripped punctuation stay in the
 * text runs. Quoted spaced paths go first, then bare spaced runs, then single words.
 */
export function splitProse(text: string): ProsePiece[] | null {
  // Cheap guard: every chip has a slash or a dot.
  if (!text.includes("/") && !text.includes(".")) return null;
  const quoted = quotedSpans(text);
  const decided: Span[] = [...quoted];
  gaps(quoted, 0, text.length, (a, b) => decided.push(...runSpans(text, a, b)));
  decided.sort((x, y) => x.start - y.start);
  const spans: Span[] = decided.filter((s) => s.hit);
  gaps(decided, 0, text.length, (a, b) => {
    wordChips(text, a, b, spans);
  });
  if (spans.length === 0) return null;
  spans.sort((x, y) => x.start - y.start);
  const out: ProsePiece[] = [];
  let last = 0;
  for (const s of spans) {
    if (!s.hit) continue;
    if (s.start > last) out.push(text.slice(last, s.start));
    out.push(s.hit);
    last = s.end;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Where a chip's relative paths resolve: the thread's checkout (home for a thread without a project). */
export interface PathPlace {
  /** The project id; "" for none. */
  project: string;
  /** Absolute directory. */
  base: string;
}

/** The File tab a chip opens: absolute and `~/` paths as typed, relative ones against the place's base. */
export function chipTarget(m: Pick<PathMatch, "path" | "line">, place: PathPlace): { project: string; base: string; path: string; line?: number } {
  return { project: place.project, base: place.base, path: resolvePath(place.base, m.path), ...(m.line !== undefined && { line: m.line }) };
}

interface HastNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
}

/** Elements whose text is never chipped in prose: code (inline code is matched whole by the renderer), links, keys. */
const SKIP: ReadonlySet<string> = new Set(["code", "pre", "a", "kbd", "script", "style"]);

/** The hast property the prose pass marks a chip with (rendered as `data-cf-path` on a span the renderer swaps for a chip). */
export const CHIP_PROP = "dataCfPath";

/**
 * A rehype plugin: prose paths in text nodes become `<span data-cf-path="token">token</span>`
 * (components/pr/Markdown renders those as chips). Runs after sanitize, so the mark is ours.
 * Linear in the text; a text node without a slash or a dot is skipped at once.
 */
export function rehypePathChips() {
  const walk = (n: HastNode) => {
    const kids = n.children;
    if (!kids) return;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (!c) continue;
      if (c.type === "element") {
        if (!SKIP.has(c.tagName ?? "")) walk(c);
        continue;
      }
      if (c.type !== "text" || !c.value) continue;
      const pieces = splitProse(c.value);
      if (!pieces) continue;
      const nodes: HastNode[] = pieces.map((p) =>
        typeof p === "string" ? { type: "text", value: p } : { type: "element", tagName: "span", properties: { [CHIP_PROP]: p.text }, children: [{ type: "text", value: p.text }] },
      );
      kids.splice(i, 1, ...nodes);
      i += nodes.length - 1;
    }
  };
  return walk;
}
