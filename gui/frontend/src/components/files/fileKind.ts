/**
 * What the File and Diff tabs show about a file besides its contents: its language's name,
 * its icon, its size and line count, and where a diff's first change is. Which preview kind
 * a file is: previews/registry.ts. Pure.
 */
import { getFiletypeFromFileName, type FileDiffMetadata } from "@pierre/diffs";
import { FileArchive, FileCode, FileImage, FileJson, FileTerminal, FileText, File as FileIcon, type LucideIcon } from "lucide-react";
import { extOf } from "@/lib/filePath";

/** Display names for the library's language ids where capitalizing the id is wrong. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  typescript: "TypeScript",
  tsx: "TSX",
  javascript: "JavaScript",
  jsx: "JSX",
  json: "JSON",
  jsonc: "JSON",
  yaml: "YAML",
  toml: "TOML",
  html: "HTML",
  css: "CSS",
  scss: "SCSS",
  mdx: "MDX",
  sql: "SQL",
  xml: "XML",
  svg: "SVG",
  php: "PHP",
  cpp: "C++",
  csharp: "C#",
  objc: "Objective-C",
  graphql: "GraphQL",
  protobuf: "Protocol Buffers",
  sh: "Shell",
  bash: "Shell",
  zsh: "Shell",
  shellscript: "Shell",
  text: "Plain text",
  dockerfile: "Dockerfile",
  makefile: "Makefile",
  go: "Go",
};

/** The language the highlighter picks for a file name, as a name ("TypeScript", "Go", "Plain text"). */
export function languageOf(path: string): string {
  const id = getFiletypeFromFileName(path);
  return LANGUAGE_NAMES[id] ?? (id ? id.charAt(0).toUpperCase() + id.slice(1) : "Plain text");
}

const ARCHIVES = new Set(["zip", "gz", "tgz", "tar", "bz2", "xz", "7z", "dmg"]);
const SHELL = new Set(["sh", "bash", "zsh", "fish"]);
const PROSE = new Set(["md", "markdown", "mdx", "txt", "rst", "adoc"]);

/** A lucide file icon for the header: image, PDF, archive, JSON, shell, prose, else code (a plain file without an extension). */
export function fileIconOf(path: string, mime = ""): LucideIcon {
  const ext = extOf(path);
  if (mime.startsWith("image/")) return FileImage;
  if (mime === "application/pdf" || ext === "pdf") return FileText;
  if (ARCHIVES.has(ext)) return FileArchive;
  if (ext === "json" || ext === "jsonc") return FileJson;
  if (SHELL.has(ext)) return FileTerminal;
  if (PROSE.has(ext)) return FileText;
  return ext ? FileCode : FileIcon;
}

/** "312 B", "58 KB" (below 1 MiB), "4.2 MB"; KB and MB are 1024-based, as Finder's sizes are not but the daemon's caps are. */
export function formatSize(bytes: number): string {
  const KiB = 1024;
  const MiB = KiB * KiB;
  if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MB`;
  if (bytes >= KiB) return `${String(Math.round(bytes / KiB))} KB`;
  return `${String(bytes)} B`;
}

/** Lines in a text: a final newline ends the last line rather than starting another; "" has none. */
export function lineCount(text: string): number {
  if (!text) return 0;
  let n = 1;
  for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) n++;
  return text.endsWith("\n") ? n - 1 : n;
}

/** The new side's 1-based line of the first change (an added line, else where lines were removed); null without hunks. */
export function firstChangeLine(diff: Pick<FileDiffMetadata, "hunks">): number | null {
  for (const h of diff.hunks) {
    for (const c of h.hunkContent) {
      if (c.type === "change") return c.additionLineIndex + 1;
    }
  }
  return null;
}

/** A PDF's header meta: "3 pages · 4.2 MB · PDF"; "4.2 MB · PDF" until pdf.js has counted its pages. */
export function pdfMeta(size: number, pages: number | null): string {
  const count = pages === null ? "" : `${String(pages)} ${pages === 1 ? "page" : "pages"} · `;
  return `${count}${formatSize(size)} · PDF`;
}

/** An image or PDF that did not come back whole (over the read cap): "PDF · 48 MB · too large to show". */
export function tooLargeHeading(kind: string, size: number): string {
  return `${kind} · ${formatSize(size)} · too large to show`;
}

/** "Showing the first 1 MiB of 4.2 MB": the daemon returns at most 1 MiB of a text file, so a truncated text read is exactly that. */
export function truncatedNotice(size: number): string {
  return `Showing the first 1 MiB of ${formatSize(size)}`;
}
