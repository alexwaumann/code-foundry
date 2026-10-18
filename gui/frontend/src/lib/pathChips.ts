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
 * Either way the token is one path with no whitespace, optionally followed by `:line`,
 * `:line:col` or `:line-line` (a range opens at its first line). It is rejected when it:
 *
 * - has `://` (a URL) or starts with a domain-looking segment (`github.com/a/b`);
 * - starts with `-` (a flag), `@` (a scoped package, a decorator) or `$`;
 * - has a character a path in prose does not ("*?[]{}()<>|&;=,$`'\"\\#", whitespace): globs,
 *   shell, code;
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
 * know, minus ones that read as words or members (`console.log`, `.r`, `.m`). Paths with
 * spaces are not detected.
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
const LETTER = /\p{L}/u;
const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

function hasKnownExtension(name: string): boolean {
  if (NAMES.has(name)) return true;
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return false;
  return EXTENSIONS.has(name.slice(i + 1).toLowerCase());
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
  if (!PATH_CHARS.test(path) || !LETTER.test(path)) return null;
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

/**
 * A prose text split into text and path chips, or null when it has none (the common case:
 * callers keep the original node). Whitespace and stripped punctuation stay in the text runs.
 */
export function splitProse(text: string): ProsePiece[] | null {
  // Cheap guard: every chip has a slash or a dot.
  if (!text.includes("/") && !text.includes(".")) return null;
  const out: ProsePiece[] = [];
  let last = 0;
  let found = false;
  for (const w of text.matchAll(/\S+/g)) {
    const word = w[0];
    const lead = LEAD.exec(word)?.[0].length ?? 0;
    let core = word.slice(lead);
    const trail = TRAIL.exec(core)?.[0] ?? "";
    // A trailing ":12" survives: only punctuation after the digits goes.
    core = core.slice(0, core.length - trail.length);
    const hit = core ? matchPath(core, "prose") : null;
    if (!hit) continue;
    const start = w.index + lead;
    if (start > last) out.push(text.slice(last, start));
    out.push(hit);
    last = start + core.length;
    found = true;
  }
  if (!found) return null;
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
