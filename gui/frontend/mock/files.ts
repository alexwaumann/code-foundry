/**
 * FilesystemService.ReadFile and ProjectService.GetWorktreeFileDiff for the mock daemon
 * (the File and Diff panel tabs, docs/notes/file-viewer-3-tabs.md). A small fixed disk in
 * the code-foundry main worktree (a README, a TypeScript file, an HTML page, images and PDFs
 * under and over the 32 MiB read cap, a binary, a folder, a 4 MB log), and every changed file of a worktree detail (mock/github.ts)
 * on both sides: its old side derived from the new one by its status letter. Anything else is
 * not found.
 *
 *   POST /__mock/fs/write?path=…&text=…   (a file's new contents on disk; reset restores the fixtures)
 *   GET  /__mock/fs/calls                 ("read <path>", "diff <worktree> <file> <scope>")
 */
import { Code, ConnectError } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { PreviewFileResponseSchema, ReadFileResponseSchema } from "../src/gen/codefoundry/v1/filesystem_pb";
import { DiffScope, type GetWorktreeFileDiffResponseSchema } from "../src/gen/codefoundry/v1/project_pb";
import { readFileSync } from "node:fs";
import { HOME } from "./filesystem";
import { pagelibPages } from "./pagelib";
import { testPdf } from "./pdf";

type ReadInit = MessageInitShape<typeof ReadFileResponseSchema>;
type PreviewInit = MessageInitShape<typeof PreviewFileResponseSchema>;
type DiffInit = MessageInitShape<typeof GetWorktreeFileDiffResponseSchema>;

/** What the detail fixtures say about a changed file (mock/github.ts FileInit). */
export interface ChangedFile {
  path: string;
  status: string;
  oldPath?: string;
  binary?: boolean;
  uncommitted?: boolean;
}

/** A worktree's detail as far as diffs need it. */
export interface DetailFiles {
  projectId: string;
  baseRef?: string;
  files?: ChangedFile[];
}

const CF = `${HOME}/src/code-foundry`;
const MiB = 1024 * 1024;
const enc = new TextEncoder();
/** 2×2 PNG (two opaque, two transparent pixels). */
const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVQIW2P8z8DwnwEIGBkZGRgYGAA2sAQB7sfJ5gAAAABJRU5ErkJggg==", "base64"),
);
/** The daemon's caps: at most 1 MiB of a text file, at most 32 MiB of anything else. */
const TEXT_MAX = MiB;
const READ_MAX = 32 * MiB;
/** The 2×2 PNG grown past 1 MiB with bytes after its end, which decoders ignore: whole only under the larger cap. */
const BIG_PNG = (() => {
  const b = new Uint8Array(Math.round(1.5 * MiB));
  b.set(PNG);
  return b;
})();

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

/** A page that calls Code Foundry through /cf/bridge.js (mock/bridge-page.html; docs/notes/bridge-2-gui.md). */
export const BRIDGE_PAGE_HTML = readFileSync(new URL("./bridge-page.html", import.meta.url), "utf8");

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
}

function text(s: string, mime = "text/plain; charset=utf-8"): Entry {
  return { data: enc.encode(s), mime };
}

function fixtures(): Map<string, Entry> {
  return new Map<string, Entry>([
    [`${CF}/README.md`, text(README, "text/markdown")],
    [`${CF}/src/app.ts`, text(APP_TS, "text/typescript")],
    [`${CF}/docs/preview.html`, text(PREVIEW_HTML, "text/html")],
    [`${CF}/docs/hello.html`, text(INLINE_PAGE_HTML, "text/html")],
    [`${CF}/docs/plain.html`, text(PLAIN_PAGE_HTML, "text/html")],
    [`${CF}/docs/scheme.html`, text(SCHEME_PAGE_HTML, "text/html")],
    [`${CF}/docs/bridge.html`, text(BRIDGE_PAGE_HTML, "text/html")],
    [`${CF}/docs/probe.html`, text(PROBE_PAGE_HTML, "text/html")],
    // The page library's pages (mock/pagelib/; e2e/page-library.spec.ts).
    ...Object.entries(pagelibPages()).map(([name, html]): [string, Entry] => [`${CF}/docs/pagelib/${name}`, text(html, "text/html")]),
    // Outside the checkout, so it is served under a grant of its own.
    [`${HOME}/elsewhere/bridge.html`, text(BRIDGE_PAGE_HTML, "text/html")],
    [`${CF}/docs/logo.png`, { data: PNG, mime: "image/png", binary: true }],
    // Over 1 MiB, so they come back whole only because the File tab asks for more.
    [`${CF}/docs/photo.png`, { data: BIG_PNG, mime: "image/png", binary: true }],
    [`${CF}/docs/spec.pdf`, { data: Uint8Array.from(testPdf(3, Math.round(1.2 * MiB))), mime: "application/pdf", binary: true }],
    // Over 32 MiB: only the first bytes would come back (the data stands in for them).
    [`${CF}/docs/huge.png`, { data: PNG, mime: "image/png", binary: true, size: 50_000_000 }],
    [`${CF}/docs/huge.pdf`, { data: Uint8Array.from(testPdf(1)), mime: "application/pdf", binary: true, size: 50_000_000 }],
    [`${CF}/bin/tool`, { data: Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 1]), mime: "application/octet-stream", binary: true, size: 2_400_000 }],
    [`${CF}/docs`, { data: new Uint8Array(), mime: "", dir: true, size: 192 }],
    [`${CF}/big.log`, { data: enc.encode("start of a long log\n".repeat(10)), mime: "text/plain; charset=utf-8", size: 4_400_000 }],
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
  readonly calls: string[] = [];

  constructor(private readonly detailOf: (path: string) => DetailFiles | undefined) {}

  reset(): void {
    this.disk = fixtures();
    this.calls.length = 0;
  }

  write(path: string, s: string): void {
    this.disk.set(path, text(s, this.disk.get(path)?.mime ?? "text/plain; charset=utf-8"));
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

  /** Grants mock/preview-<n> ids per scope: code-foundry's checkout for its files, else the file's directory. */
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
    this.calls.push(`preview ${abs}`);
    return { url: `/preview/${grant}/${rel.split("/").map(encodeURIComponent).join("/")}`, scope };
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
    this.calls.push(`read ${abs}`);
    if (abs !== HOME && !abs.startsWith(`${HOME}/`)) throw new ConnectError(`${abs} is outside the home directory`, Code.InvalidArgument);
    const e = this.onDisk(abs);
    if (!e) return { resolvedPath: abs, notFound: true };
    const modifiedAt = BigInt(Date.now() - 2 * 60_000);
    if (e.dir) return { resolvedPath: abs, isDir: true, size: BigInt(e.size ?? 0), modifiedAt };
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
    };
  }

  fileDiff(worktree: string, file: string, oldPath: string, scope: DiffScope): DiffInit {
    if (!file || file.startsWith("/") || file.split("/").includes("..")) throw new ConnectError(`file ${JSON.stringify(file)} must be a path inside the worktree`, Code.InvalidArgument);
    const detail = this.detailOf(worktree);
    if (!detail) throw new ConnectError(`worktree ${worktree} not found`, Code.NotFound);
    const branch = scope === DiffScope.BRANCH;
    this.calls.push(`diff ${worktree} ${file} ${branch ? "branch" : "working"}`);
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
