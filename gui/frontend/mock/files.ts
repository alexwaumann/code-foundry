/**
 * FilesystemService.ReadFile and ProjectService.GetWorktreeFileDiff for the mock daemon
 * (the File and Diff panel tabs, docs/notes/file-viewer-3-tabs.md). A small fixed disk in
 * the code-foundry main worktree (a README, a TypeScript file, HTML pages, images, PDFs and
 * a folder), and every changed file of a worktree detail (mock/github.ts)
 * on both sides: its old side derived from the new one by its status letter. Anything else is
 * not found.
 *
 *   POST /__mock/fs/write?path=…&text=…   (a file's new contents on disk; reset restores the fixtures)
 *   POST /__mock/fs/link?path=…&real=…    (ReadFile says a link leads from the path to real; reset forgets it)
 *   GET  /__mock/fs/text?path=…           ({ text }: a file's contents on disk, null when absent)
 */
import { Code, ConnectError } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromMs, type Timestamp } from "@bufbuild/protobuf/wkt";
import type { PreviewFileResponseSchema, ReadFileResponseSchema, WriteFileRequest, WriteFileResponseSchema } from "../src/gen/codefoundry/v1/filesystem_pb";
import { DiffScope, DiffSourceKind, type CompareWorktreeResponseSchema, type DiffSource, type GetWorktreeCompareFileResponseSchema, type GetWorktreeFileDiffResponseSchema, type ListCompareCommitsResponseSchema } from "../src/gen/codefoundry/v1/project_pb";
import { readFileSync } from "node:fs";
import { crc32, deflateSync } from "node:zlib";
import { HOME } from "./filesystem";
import { pagelibPages } from "./pagelib";
import { testPdf } from "./pdf";

type ReadInit = MessageInitShape<typeof ReadFileResponseSchema>;
type WriteInit = MessageInitShape<typeof WriteFileResponseSchema>;
type PreviewInit = MessageInitShape<typeof PreviewFileResponseSchema>;
type DiffInit = MessageInitShape<typeof GetWorktreeFileDiffResponseSchema>;
type CompareInit = MessageInitShape<typeof CompareWorktreeResponseSchema>;
type CompareLogInit = MessageInitShape<typeof ListCompareCommitsResponseSchema>;

/** A side the Commits list set: a full sha. */
const isCommit = (s: CompareSide): boolean => s?.kind === DiffSourceKind.REF && s.ref.length === 40;
type CompareFileInit = MessageInitShape<typeof GetWorktreeCompareFileResponseSchema>;
/** One side of a comparison request; unset is that side's default. */
type CompareSide = DiffSource | undefined;

/** What the detail fixtures say about a changed file (mock/github.ts FileInit). */
export interface ChangedFile {
  path: string;
  status: string;
  oldPath?: string;
  binary?: boolean;
  uncommitted?: boolean;
  added?: number;
  deleted?: number;
}

/** A worktree's detail as far as diffs need it. */
export interface DetailFiles {
  projectId: string;
  baseRef?: string;
  files?: ChangedFile[];
  log?: { sha?: string; shortSha?: string; subject?: string; authoredAt?: Timestamp }[];
}

const CF = `${HOME}/src/code-foundry`;
const MiB = 1024 * 1024;
const enc = new TextEncoder();
/** 2×2 PNG (two opaque, two transparent pixels). */
const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQIW2P8z8DwnwEIGBkZGRgYGAA2sAQB7sfJ5gAAAABJRU5ErkJggg==", "base64"),
);
/** The daemon's caps: at most 1 MiB of a text file, at most 32 MiB of anything else. */
/** The temp folders, as spelled and resolved (fsx.TempRoots): readable, unlike the rest outside home. */
const TEMP_ROOTS = ["/tmp", "/private/tmp"];
const inTemp = (abs: string) => TEMP_ROOTS.some((t) => abs === t || abs.startsWith(`${t}/`));
const TEXT_MAX = MiB;
const READ_MAX = 32 * MiB;
/** The 2×2 PNG grown past 1 MiB with bytes after its end, which decoders ignore: whole only under the larger cap. */
const BIG_PNG = (() => {
  const b = new Uint8Array(Math.round(1.5 * MiB));
  b.set(PNG);
  return b;
})();

/** A width by height PNG of one colour: large in pixels and small on disk, as a screenshot of nothing is. */
function solidPng(width: number, height: number): Uint8Array {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2], 8); // 8 bits, RGB
  const row = Buffer.alloc(1 + width * 3, 0x60);
  row[0] = 0; // no filter
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Uint8Array.from(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", header), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]));
}

const README_OLD = `# code-foundry

Run fleets of Claude Code threads across git worktrees.

## Build

\`\`\`sh
make build
\`\`\`
`;

export const README = `# code-foundry

Run fleets of **Claude Code** threads across git worktrees, from one window.

![logo](docs/logo.png)

## Build

\`\`\`sh
make build
make check
\`\`\`

## Layout

| Path | What |
| --- | --- |
| \`internal/\` | the daemon |
| \`gui/\` | the window |

- [x] File tab
- [ ] Path chips

See [the plan](https://example.com/plan) for what comes next.
`;

export const APP_TS = Array.from({ length: 80 }, (_, i) => {
  const n = i + 1;
  if (n === 1) return `import { createServer } from "node:http";`;
  if (n === 3) return `/** Starts the app on a port. */`;
  if (n === 42) return `export function handler(req: Request): Response {`;
  if (n === 43) return `  return new Response("hello from line 43");`;
  if (n === 44) return `}`;
  return n % 10 === 0 ? `// section ${String(n / 10)}` : `const value${String(n)} = ${String(n)} * 2;`;
}).join("\n") + "\n";

export const PREVIEW_HTML = `<!doctype html>
<html><head><title>Preview</title><style>body{font-family:sans-serif;color:#123;margin:24px} h1{color:#0a6}</style></head>
<body>
<h1 id="title">Hello from the preview</h1>
<p>A paragraph with <strong>bold</strong> text. <a id="anchor" href="#title">Top</a> · <a id="sibling" href="../docs/logo.png">Logo</a></p>
<img id="local" src="logo.png" alt="local">
<button id="count" type="button">0 clicks</button>
<script>
document.getElementById("title").textContent = "script ran";
let n = 0;
document.getElementById("count").addEventListener("click", () => { n++; document.getElementById("count").textContent = n + " clicks"; });
</script>
</body></html>
`;

/**
 * The page the scripted thread's "html" state shows inline (mock/thread.ts; docs/notes/
 * inline-html.md): it links /cf/theme.css, paints with the --cf-* slots, and asks for its
 * height with cf:resize, as the skill tells the model to.
 */
export const INLINE_PAGE_HTML = `<!doctype html>
<html><head><title>Hello</title><link rel="stylesheet" href="/cf/theme.css">
<style>
body{margin:0;padding:20px 24px;background:var(--cf-surface-raised);color:var(--cf-text);font-family:system-ui,sans-serif}
h1{margin:0 0 4px;font-size:20px} p{margin:0 0 14px;color:var(--cf-text-muted)}
button{background:var(--cf-accent);color:var(--cf-accent-foreground);border:0;border-radius:6px;padding:6px 14px;font:inherit;cursor:pointer}
</style></head>
<body>
<h1 id="hello">Hello</h1>
<p>A small page shown inline in the conversation.</p>
<button id="wave" type="button">Wave</button>
<script>
let n = 0;
document.getElementById("wave").addEventListener("click", () => { n++; document.getElementById("hello").textContent = "Hello x" + n; });
// The body's height, not documentElement.scrollHeight: that is never less than the frame's own height, so a page could only grow.
const ask = () => parent.postMessage({ type: "cf:resize", height: Math.ceil(document.body.getBoundingClientRect().height) }, "*");
addEventListener("load", ask);
new ResizeObserver(ask).observe(document.body);
// Follows the app's theme live (cf:theme), not only the slots /cf/theme.css had at load,
// and acks it so the frame keeps the page (and its count) instead of reloading it.
addEventListener("message", (e) => {
  if (e.data?.type !== "cf:theme") return;
  document.documentElement.style.colorScheme = e.data.scheme;
  for (const [k, v] of Object.entries(e.data.vars)) document.documentElement.style.setProperty(k, v);
  parent.postMessage({ type: "cf:theme:ack" }, "*");
});
</script>
</body></html>
`;

/**
 * A page that only links /cf/theme.css (no cf:theme listener): a theme switch reloads its
 * frame so it repaints, and its count starts again (docs/notes/inline-html-2-fixes.md).
 */
export const PLAIN_PAGE_HTML = `<!doctype html>
<html><head><title>Plain</title><link rel="stylesheet" href="/cf/theme.css">
<style>body{margin:0;padding:16px 24px;background:var(--cf-surface-raised);color:var(--cf-text);font-family:system-ui,sans-serif}</style></head>
<body><p id="plain">Stylesheet only</p><button id="tick" type="button">Tick</button>
<script>
let n = 0;
document.getElementById("tick").addEventListener("click", () => { n++; document.getElementById("plain").textContent = "Ticked " + n; });
addEventListener("load", () => parent.postMessage({ type: "cf:resize", height: Math.ceil(document.body.getBoundingClientRect().height) }, "*"));
</script>
</body></html>
`;

/**
 * A page that hard-codes its colours in a prefers-color-scheme block, as a page written for
 * a browser does: the frame's color-scheme makes it follow the app's scheme, not the
 * system's (docs/notes/inline-html-2-fixes.md). #scheme says which one the page sees.
 */
export const SCHEME_PAGE_HTML = `<!doctype html>
<html><head><title>Scheme</title>
<style>
body{margin:0;padding:16px 24px;background:#ffffff;color:#111111;font-family:system-ui,sans-serif}
@media (prefers-color-scheme: dark){body{background:#101010;color:#eeeeee}}
</style></head>
<body><p id="scheme">?</p>
<script>
const m = matchMedia("(prefers-color-scheme: dark)");
const show = () => { document.getElementById("scheme").textContent = m.matches ? "sees dark" : "sees light"; };
show();
m.addEventListener("change", show);
addEventListener("load", () => parent.postMessage({ type: "cf:resize", height: Math.ceil(document.body.getBoundingClientRect().height) }, "*"));
</script>
</body></html>
`;

/**
 * A page with no stylesheet, no background and no cf:resize, taller than its card, so the
 * card scrolls inside (docs/notes/inline-page-frame.md): a wheel up over it at its top must
 * scroll the thread, and it must not show white while it loads or after.
 */
export const TALL_PAGE_HTML = `<!doctype html>
<html><head><title>Tall</title></head>
<body><h1 id="tall">A tall page</h1>
${Array.from({ length: 40 }, (_, i) => `<p>Line ${String(i + 1)} of a page longer than its card.</p>`).join("\n")}
</body></html>
`;

/** A page that calls Code Foundry through /cf/bridge.js (mock/bridge-page.html; docs/notes/bridge-2-gui.md). */
export const BRIDGE_PAGE_HTML = readFileSync(new URL("./bridge-page.html", import.meta.url), "utf8");

/** Where the daemon places the first-run welcome page (internal/skills welcome.go). */
export const WELCOME_PAGE = `${HOME}/.code-foundry/pages/welcome.html`;
/** The page itself, from the pages skill (the one source the daemon embeds). */
const WELCOME_HTML = readFileSync(new URL("../../../internal/skills/files/code-foundry-pages/reference/welcome.html", import.meta.url), "utf8");

/**
 * A page with no thread that tries every other frame on screen (docs/notes/bridge-fix-frames.md):
 * body[data-probe] lists "blocked" or "reached" per sibling, from an opaque origin always "blocked".
 */
export const PROBE_PAGE_HTML = `<!doctype html>
<html><head><title>Probe</title></head>
<body><p id="probe">?</p>
<script>
const out = [];
for (let i = 0; i < parent.frames.length; i++) {
  const w = parent.frames[i];
  if (w === window) continue;
  try {
    void w.document.title;
    out.push("reached");
  } catch (e) {
    out.push("blocked");
  }
}
document.body.dataset.probe = out.join(",");
document.getElementById("probe").textContent = out.join(", ") || "no siblings";
</script>
</body></html>
`;

interface Entry {
  data: Uint8Array;
  mime: string;
  binary?: boolean;
  /** The size on disk when it is more than the data (a truncated read). */
  size?: number;
  dir?: boolean;
  /** When it was last written (unix ms); unset: two minutes before the read. */
  modifiedAt?: number;
}

function text(s: string, mime = "text/plain; charset=utf-8"): Entry {
  return { data: enc.encode(s), mime };
}

/** The fixtures' modification time: fixed, so a stamp (size and time) changes only with a write. */
const FIXTURE_MTIME = Date.now() - 2 * 60_000;

function fixtures(): Map<string, Entry> {
  return new Map<string, Entry>([
    [`${CF}/README.md`, text(README, "text/markdown")],
    [`${CF}/src/app.ts`, text(APP_TS, "text/typescript")],
    [`${CF}/docs/preview.html`, text(PREVIEW_HTML, "text/html")],
    [`${CF}/docs/hello.html`, text(INLINE_PAGE_HTML, "text/html")],
    [`${CF}/docs/plain.html`, text(PLAIN_PAGE_HTML, "text/html")],
    [`${CF}/docs/scheme.html`, text(SCHEME_PAGE_HTML, "text/html")],
    [`${CF}/docs/tall.html`, text(TALL_PAGE_HTML, "text/html")],
    [`${CF}/docs/bridge.html`, text(BRIDGE_PAGE_HTML, "text/html")],
    // Another file of the same page, under the same grant (e2e/bridge.spec.ts).
    [`${CF}/docs/bridge-next.html`, text(BRIDGE_PAGE_HTML, "text/html")],
    [`${CF}/docs/probe.html`, text(PROBE_PAGE_HTML, "text/html")],
    // The page library's pages (mock/pagelib/; e2e/page-library.spec.ts).
    ...Object.entries(pagelibPages()).map(([name, html]): [string, Entry] => [`${CF}/docs/pagelib/${name}`, text(html, "text/html")]),
    // Outside every project, as the daemon places it (e2e/welcome-page.spec.ts).
    [WELCOME_PAGE, text(WELCOME_HTML, "text/html")],
    // Outside the checkout, so it is served under a grant of its own.
    [`${HOME}/elsewhere/bridge.html`, text(BRIDGE_PAGE_HTML, "text/html")],
    [`${CF}/docs/logo.png`, { data: PNG, mime: "image/png", binary: true }],
    // Over 1 MiB, so they come back whole only because the File tab asks for more.
    [`${CF}/docs/photo.png`, { data: BIG_PNG, mime: "image/png", binary: true }],
    // A gallery's worth (e2e/gallery.spec.ts), and one that is no picture whatever its name says.
    ...Array.from({ length: 60 }, (_, i): [string, Entry] => [`${CF}/docs/shots/shot-${String(i + 1)}.png`, { data: PNG, mime: "image/png", binary: true }]),
    [`${CF}/docs/shots/large.png`, { data: solidPng(1600, 1000), mime: "image/png", binary: true }],
    [`${CF}/docs/shots/broken.png`, { data: enc.encode("not a picture"), mime: "image/png", binary: true }],
    [`${CF}/docs/spec.pdf`, { data: Uint8Array.from(testPdf(3, Math.round(1.2 * MiB))), mime: "application/pdf", binary: true }],
    [`${CF}/docs`, { data: new Uint8Array(), mime: "", dir: true, size: 192 }],
  ]);
}

/** A changed file's text on disk (its new side) when no fixture has it. */
function generated(path: string): string {
  const lines = Array.from({ length: 30 }, (_, i) => `line ${String(i + 1)} of ${path}`);
  lines[11] = `line 12 of ${path}, changed`;
  lines.splice(20, 0, `an added line in ${path}`);
  return lines.join("\n") + "\n";
}

/** The old side the status implies for a new side. */
function olderOf(path: string, now: string): string {
  if (path.endsWith("README.md")) return README_OLD;
  return now.replace(", changed", "").replace(`an added line in ${path}\n`, "");
}

export class MockFiles {
  private disk = fixtures();

  constructor(private readonly detailOf: (path: string) => DetailFiles | undefined) {}

  /** POST /__mock/compare/files?count=N[&first=M]: this many more files in every comparison, for a long list, and M that sort above them all. */
  extraCompareFiles = 0;
  firstCompareFiles = 0;
  /** POST /__mock/compare/commits?count=N: this many more commits on every list, older than the worktree's own. */
  extraCompareCommits = 0;
  /** Characters of the newest commit's subject, past its own, to see a long message (its body grows too). */
  longCommitSubject = 0;

  reset(): void {
    this.extraCompareFiles = 0;
    this.firstCompareFiles = 0;
    this.extraCompareCommits = 0;
    this.longCommitSubject = 0;
    this.links.clear();
    this.disk = fixtures();
  }

  /** Where a path's link leads, for ReadFile's real_path; POST /__mock/fs/link. */
  readonly links = new Map<string, string>();

  /** ReadFile's answer with where its file really is: a link if one was set, and 0644 behind one. */
  readWithLink(baseDir: string, path: string, maxBytes: bigint): ReadInit {
    const r = this.readFile(baseDir, path, maxBytes);
    const real = this.links.get(r.resolvedPath ?? "");
    return real === undefined ? r : { ...r, realPath: real, mode: 0o644 };
  }

  /** A file's contents as text; null when nothing is there. */
  textOf(path: string): string | null {
    const e = this.onDisk(path);
    return e ? new TextDecoder().decode(e.data) : null;
  }

  /** Whether a folder is at `abs`: one listed as such, or one holding a file. */
  hasFolder(abs: string): boolean {
    if (this.disk.get(abs)?.dir) return true;
    for (const p of this.disk.keys()) if (p.startsWith(`${abs}/`)) return true;
    return false;
  }

  /** Writes a file's contents; with `touch`, only its modification time moves (touch(1); `s` is ignored). */
  write(path: string, s: string, touch = false): void {
    const was = this.disk.get(path);
    const modifiedAt = Math.max(Date.now(), (was?.modifiedAt ?? 0) + 1);
    if (touch && was) {
      this.disk.set(path, { ...was, modifiedAt });
      return;
    }
    this.disk.set(path, { ...text(s, was?.mime ?? "text/plain; charset=utf-8"), modifiedAt });
  }

  /** The worktree that has `abs` among its changed files, and that file. */
  private changed(abs: string): { worktree: string; file: ChangedFile } | undefined {
    for (const wt of [CF, `${CF}.worktrees/feat-sidebar`, `${CF}.worktrees/fix-resize`, `${HOME}/src/ghostty-playground`]) {
      if (!abs.startsWith(`${wt}/`)) continue;
      const rel = abs.slice(wt.length + 1);
      const file = this.detailOf(wt)?.files?.find((f) => f.path === rel);
      if (file) return { worktree: wt, file };
    }
    return undefined;
  }

  /** The file on disk now, fixtures first, then a changed file's generated contents. */
  private onDisk(abs: string): Entry | undefined {
    const e = this.disk.get(abs);
    if (e) return e;
    const c = this.changed(abs);
    if (!c || c.file.status === "D") return undefined;
    if (c.file.binary) return { data: PNG, mime: "image/png", binary: true };
    return text(generated(c.file.path));
  }

  /** Grants mock/preview-<n> ids per scope: code-foundry's checkout for its files, else the file's directory (a temp folder is no tree: the response names the file alone). */
  private grants = new Map<string, string>();

  previewFile(baseDir: string, path: string): PreviewInit {
    const r = this.readFile(baseDir, path, 1n);
    const abs = r.resolvedPath ?? "";
    if (r.notFound) throw new ConnectError(`${abs} does not exist`, Code.NotFound);
    if (r.isDir) throw new ConnectError(`${abs} is a directory`, Code.InvalidArgument);
    const scope = abs.startsWith(`${CF}/`) ? CF : abs.slice(0, abs.lastIndexOf("/"));
    let grant = this.grants.get(scope);
    if (!grant) {
      grant = `mock-preview-${String(this.grants.size + 1)}`;
      this.grants.set(scope, grant);
    }
    const rel = abs.slice(scope.length + 1);
    const single = TEMP_ROOTS.includes(scope);
    return { url: `/preview/${grant}/${rel.split("/").map(encodeURIComponent).join("/")}`, scope: single ? abs : scope, singleFile: single };
  }

  /** GET /preview/<grant>/<path>: the file under the grant's scope (a directory serves its index.html), or undefined. */
  previewEntry(pathname: string): { data: Uint8Array; mime: string } | undefined {
    const m = /^\/preview\/([^/]+)\/(.*)$/.exec(pathname);
    if (!m) return undefined;
    const scope = [...this.grants].find(([, id]) => id === m[1])?.[0];
    if (scope === undefined) return undefined;
    const rel = decodeURIComponent(m[2] ?? "");
    if (rel.split("/").includes("..")) return undefined;
    const abs = normalize(`${scope}/${rel}`);
    if (abs !== scope && !abs.startsWith(`${scope}/`)) return undefined;
    const e = this.onDisk(abs) ?? this.onDisk(`${abs}/index.html`);
    return e && !e.dir ? { data: e.data, mime: e.mime } : undefined;
  }

  readFile(baseDir: string, path: string, maxBytes: bigint): ReadInit {
    if (maxBytes < 0n) throw new ConnectError("max_bytes is negative", Code.InvalidArgument);
    let abs = path;
    if (path === "~" || path.startsWith("~/")) abs = HOME + path.slice(1);
    else if (!path.startsWith("/")) {
      if (!baseDir.startsWith("/")) throw new ConnectError(`base_dir ${JSON.stringify(baseDir)} must be absolute`, Code.InvalidArgument);
      abs = `${baseDir}/${path}`;
    }
    abs = normalize(abs);
    const outsideHome = abs !== HOME && !abs.startsWith(`${HOME}/`);
    if (outsideHome && !inTemp(abs)) throw new ConnectError(`${abs} is outside your home directory and the temp folders`, Code.InvalidArgument);
    const e = this.onDisk(abs);
    if (!e) return { resolvedPath: abs, notFound: true, outsideHome };
    const modifiedAt = BigInt(e.modifiedAt ?? FIXTURE_MTIME);
    if (e.dir) return { resolvedPath: abs, isDir: true, size: BigInt(e.size ?? 0), modifiedAt, outsideHome };
    const size = e.size ?? e.data.length;
    // Zero is 1 MiB; text never more than 1 MiB, anything else up to 32 MiB.
    const cap = e.binary ? READ_MAX : TEXT_MAX;
    const limit = maxBytes === 0n ? TEXT_MAX : Number(maxBytes > BigInt(cap) ? BigInt(cap) : maxBytes);
    return {
      resolvedPath: abs,
      contents: e.data.slice(0, limit),
      size: BigInt(size),
      truncated: size > Math.min(limit, e.data.length),
      binary: e.binary ?? false,
      mimeType: e.mime,
      modifiedAt,
      outsideHome,
    };
  }

  /** internal/fsx Writer: a changed or vanished file is a conflict, nothing written; force writes whatever is there; create takes a place where nothing is. */
  writeFile(req: WriteFileRequest): WriteInit {
    const abs = req.path.startsWith("/") ? normalize(req.path) : normalize(`${req.baseDir}/${req.path}`);
    const e = this.onDisk(abs);
    if (e?.dir) throw new ConnectError(`${abs} is a directory`, Code.InvalidArgument);
    if (req.create) {
      if (e) return { resolvedPath: abs, modifiedAt: BigInt(e.modifiedAt ?? FIXTURE_MTIME), size: BigInt(e.size ?? e.data.length), conflict: true };
    } else if (!req.force) {
      if (!e) return { resolvedPath: abs, conflict: true, notFound: true };
      const modifiedAt = BigInt(e.modifiedAt ?? FIXTURE_MTIME);
      const size = BigInt(e.size ?? e.data.length);
      if (modifiedAt !== req.modifiedAt || size !== req.size) return { resolvedPath: abs, modifiedAt, size, conflict: true };
    }
    this.write(abs, new TextDecoder().decode(req.contents));
    const now = this.onDisk(abs);
    return { resolvedPath: abs, modifiedAt: BigInt(now?.modifiedAt ?? 0), size: BigInt(now?.data.length ?? 0) };
  }

  /** What a comparison lists: the detail's files, cut down to what the two sources can differ in. */
  compare(worktree: string, base: CompareSide, head: CompareSide): CompareInit {
    const detail = this.detailOf(worktree);
    if (!detail) throw new ConnectError(`worktree ${worktree} not found`, Code.NotFound);
    const baseRef = detail.baseRef ?? "";
    const resolved = (s: CompareSide) => {
      if (s?.kind === DiffSourceKind.REF) return { kind: s.kind, label: s.ref, sha: "ddc0461310bb" };
      if (s?.kind === DiffSourceKind.STAGED) return { kind: s.kind, label: "Staged" };
      if (s?.kind === DiffSourceKind.WORKING_TREE) return { kind: s.kind, label: "Working tree" };
      return { kind: DiffSourceKind.MERGE_BASE, label: baseRef || "HEAD", sha: "c6d3bc2477aa" };
    };
    const meta = { base: resolved(base), head: resolved(head), baseRef, mergeBase: baseRef ? "c6d3bc2477aa" : "" };
    const missing = [base, head].find((s) => s?.kind === DiffSourceKind.REF && s.ref.startsWith("gone/"));
    if (missing) return { ...meta, error: `${missing.ref} does not name a commit in this checkout` };
    // A commit from the Commits list (a full sha) shows every changed file, for something to look at.
    const committedOnly = head?.kind === DiffSourceKind.REF && !isCommit(head);
    const uncommittedOnly = base?.kind === DiffSourceKind.STAGED;
    const generated = (n: number, name: (i: number) => string) => Array.from({ length: n }, (_, i) => ({ path: name(i), oldPath: "", status: "A", added: 1, deleted: 0, binary: false }));
    const files = generated(this.firstCompareFiles, (i) => `.first/file-${String(i).padStart(4, "0")}.ts`)
      .concat((detail.files ?? [])
      .filter((f) => (committedOnly ? !f.uncommitted : uncommittedOnly ? f.uncommitted : true))
      .map((f) => ({ path: f.path, oldPath: f.oldPath ?? "", status: f.status, added: f.added ?? 0, deleted: f.deleted ?? 0, binary: f.binary ?? false })))
      .concat(generated(this.extraCompareFiles, (i) => `generated/file-${String(i).padStart(4, "0")}.ts`));
    return { ...meta, files, totalFiles: files.length, totalAdded: files.reduce((n, f) => n + f.added, 0), totalDeleted: files.reduce((n, f) => n + f.deleted, 0) };
  }

  /** The commits of a comparison: the worktree's log whatever the sides, each the next one's child; the last is a root. */
  compareCommits(worktree: string): CompareLogInit {
    const log = this.compareLog(worktree);
    const commits = log.map((e, i) => ({ sha: e.sha, shortSha: e.shortSha, subject: i === 0 ? `${e.subject ?? ""}${" long".repeat(this.longCommitSubject / 5)}` : e.subject, authoredAt: e.authoredAt, parent: log[i + 1]?.sha ?? "" }));
    return { commits, total: commits.length };
  }

  /** The worktree's log and the older commits asked for. */
  private compareLog(worktree: string) {
    const detail = this.detailOf(worktree);
    if (!detail) throw new ConnectError(`worktree ${worktree} not found`, Code.NotFound);
    const older = Array.from({ length: this.extraCompareCommits }, (_, i) => ({ sha: `e${String(i).padStart(39, "0")}`, shortSha: `e${String(i).padStart(6, "0")}`, subject: `Older commit ${String(i).padStart(4, "0")}`, authoredAt: timestampFromMs(Date.now() - (i + 1) * 3_600_000) }));
    return [...(detail.log ?? []), ...older];
  }

  /** The message under a commit's subject: the newest commit has one. */
  compareCommitBody(worktree: string, sha: string): { body: string; error: string } {
    const body = "Why it changed, in a few words.\n\nA second paragraph.";
    return { body: this.compareLog(worktree)[0]?.sha === sha ? (this.longCommitSubject ? `${body}\n`.repeat(20) : body) : "", error: "" };
  }

  /** One file of a comparison: fileDiff's two sides, a ref on the head side being the branch. */
  compareFile(worktree: string, base: CompareSide, head: CompareSide, file: string, oldPath: string): CompareFileInit {
    const missing = [base, head].find((s) => s?.kind === DiffSourceKind.REF && s.ref.startsWith("gone/"));
    if (missing) return { error: `${missing.ref} does not name a commit in this checkout` };
    const d = this.fileDiff(worktree, file, oldPath, head?.kind === DiffSourceKind.REF && !isCommit(head) ? DiffScope.BRANCH : DiffScope.WORKING);
    return { old: d.old, new: d.new, status: d.status, error: d.error };
  }

  fileDiff(worktree: string, file: string, oldPath: string, scope: DiffScope): DiffInit {
    if (!file || file.startsWith("/") || file.split("/").includes("..")) throw new ConnectError(`file ${JSON.stringify(file)} must be a path inside the worktree`, Code.InvalidArgument);
    const detail = this.detailOf(worktree);
    if (!detail) throw new ConnectError(`worktree ${worktree} not found`, Code.NotFound);
    const branch = scope === DiffScope.BRANCH;
    const baseRef = detail.baseRef ?? "";
    const meta = { baseRef, mergeBase: baseRef ? "c6d3bc2477aa" : "", head: "ddc0461310bb" };
    if (branch && !baseRef) return { ...meta, error: "the worktree has no base branch to compare with" };
    const change = detail.files?.find((f) => f.path === file);
    const disk = this.onDisk(`${worktree}/${file}`);
    const nowText = disk && !disk.binary ? new TextDecoder().decode(disk.data) : "";
    const side = (present: boolean, contents: string, binary = false) => ({ present, contents: binary ? PNG : enc.encode(contents), binary });
    const absent = { present: false };
    if (!change) {
      // Unchanged (or unknown): both sides the file as it is.
      return disk ? { ...meta, old: side(true, nowText, disk.binary), new: side(true, nowText, disk.binary), status: "" } : { ...meta, old: absent, new: absent, status: "" };
    }
    // Only in the working tree: the branch has nothing of it (untracked) or the base's version (modified).
    if (branch && change.uncommitted) {
      if (change.status === "?" || change.status === "A") return { ...meta, old: absent, new: absent, status: "" };
      const base = olderOf(file, nowText);
      return { ...meta, old: side(true, base), new: side(true, base), status: "" };
    }
    const binary = change.binary ?? false;
    switch (change.status) {
      case "A":
      case "?":
        return { ...meta, old: absent, new: side(true, nowText, binary), status: "A" };
      case "D": {
        const gone = generated(file);
        return { ...meta, old: side(true, gone, binary), new: absent, status: "D" };
      }
      case "R":
        return { ...meta, old: side(true, olderOf(oldPath || file, nowText)), new: side(true, nowText), status: oldPath && oldPath !== file ? "R" : "M" };
      default:
        return { ...meta, old: side(true, olderOf(file, nowText), binary), new: side(true, nowText, binary), status: "M" };
    }
  }
}

function normalize(p: string): string {
  const out: string[] = [];
  for (const seg of p.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") out.pop();
    else out.push(seg);
  }
  return `/${out.join("/")}`;
}
