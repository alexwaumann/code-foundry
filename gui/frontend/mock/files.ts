/**
 * FilesystemService.ReadFile and ProjectService.GetWorktreeFileDiff for the mock daemon
 * (the File and Diff panel tabs, docs/notes/file-viewer-3-tabs.md). A small fixed disk in
 * the code-foundry main worktree (a README, a TypeScript file, an HTML page, an image, a
 * binary, a folder, a 4 MB log), and every changed file of a worktree detail (mock/github.ts)
 * on both sides: its old side derived from the new one by its status letter. Anything else is
 * not found.
 *
 *   POST /__mock/fs/write?path=…&text=…   (a file's new contents on disk; reset restores the fixtures)
 *   GET  /__mock/fs/calls                 ("read <path>", "diff <worktree> <file> <scope>")
 */
import { Code, ConnectError } from "@connectrpc/connect";
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { ReadFileResponseSchema } from "../src/gen/codefoundry/v1/filesystem_pb";
import { DiffScope, type GetWorktreeFileDiffResponseSchema } from "../src/gen/codefoundry/v1/project_pb";
import { HOME } from "./filesystem";

type ReadInit = MessageInitShape<typeof ReadFileResponseSchema>;
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
<p>A paragraph with <strong>bold</strong> text.</p>
<img id="remote" src="https://example.com/x.png" alt="remote">
<script>document.getElementById("title").textContent = "script ran";</script>
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
    [`${CF}/docs/logo.png`, { data: PNG, mime: "image/png", binary: true }],
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
    const limit = maxBytes === 0n || maxBytes > BigInt(MiB) ? MiB : Number(maxBytes);
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
