/**
 * The PR Code tab's model (docs/notes/file-viewer-5-pr-code-tab.md): GitHub's unified diff
 * parsed into the library's per-file metadata, the file list's rows, and the old side of a
 * file rebuilt from its head copy for hunk expansion.
 */
import { parsePatchFiles, SPLIT_WITH_NEWLINES, type FileDiffContentsLoader, type FileDiffLoadedFiles, type FileDiffMetadata } from "@pierre/diffs";
import type { PullRequestFileView } from "@/api/prDiff";
import { splitPath } from "@/components/changes/files";

export type PrFileStatus = "A" | "M" | "D" | "R";

export interface PrDiffFile {
  /** The CodeView item's id: unique within the diff. */
  id: string;
  /** The library's metadata, parsed once per diff (hydration mutates it in place). */
  fileDiff: FileDiffMetadata;
  path: string;
  /** A rename's source; "" otherwise. */
  prevPath: string;
  /** The path's directory with its trailing slash ("" at the top level), and its basename. */
  dir: string;
  name: string;
  status: PrFileStatus;
  added: number;
  deleted: number;
  /** "Binary files … differ": no hunks to show. */
  binary: boolean;
  /** Rows of the diff (its hunks' context, additions and deletions). */
  lines: number;
  /** Starts folded: the diff is over COLLAPSE_OVER lines. */
  collapsed: boolean;
}

export interface PrDiffModel {
  files: PrDiffFile[];
  added: number;
  deleted: number;
}

/** Files with a diff longer than this start folded (pnpm-lock.yaml, generated code). */
export const COLLAPSE_OVER = 1500;

const statusOf: Record<FileDiffMetadata["type"], PrFileStatus> = {
  new: "A",
  deleted: "D",
  change: "M",
  "rename-pure": "R",
  "rename-changed": "R",
};

const BINARY = /^Binary files (?:a\/(.+)|\/dev\/null) and (?:b\/(.+)|\/dev\/null) differ$/;

/** Paths of the files the diff calls binary (git's "Binary files a/x and b/x differ"). */
function binaryPaths(text: string): Set<string> {
  const out = new Set<string>();
  if (!text.includes("\nBinary files ")) return out;
  for (const line of text.split("\n")) {
    const m = BINARY.exec(line);
    const path = m?.[2] ?? m?.[1];
    if (path) out.add(path);
  }
  return out;
}

/** Parses a pull request's diff; cacheKey (head sha) keys the library's highlight cache. */
export function parsePrDiff(text: string, cacheKey: string): PrDiffModel {
  const binary = binaryPaths(text);
  const files = parsePatchFiles(text, cacheKey || undefined).flatMap((p) => p.files);
  let added = 0;
  let deleted = 0;
  const rows = files.map((fd, i): PrDiffFile => {
    const [dir, name] = splitPath(fd.name);
    let a = 0;
    let d = 0;
    let lines = 0;
    for (const h of fd.hunks) {
      a += h.additionLines;
      d += h.deletionLines;
      lines += h.unifiedLineCount;
    }
    added += a;
    deleted += d;
    return {
      id: `${String(i)}:${fd.name}`,
      fileDiff: fd,
      path: fd.name,
      prevPath: fd.prevName ?? "",
      dir,
      name,
      status: statusOf[fd.type],
      added: a,
      deleted: d,
      binary: binary.has(fd.name),
      lines,
      collapsed: lines > COLLAPSE_OVER,
    };
  });
  return { files: rows, added, deleted };
}

const splitLines = (s: string): string[] => (s === "" ? [] : s.split(SPLIT_WITH_NEWLINES));

/** A hunk side's first line index: a zero-length side ("-5,0") sits after line 5, i.e. at index 5. */
const sideStart = (start: number, count: number): number => (count === 0 ? start : start - 1);

/**
 * The old side of a file, rebuilt from its new side and the patch: the unchanged runs
 * between hunks come from the new file, each hunk's old lines (context and deletions)
 * from the patch. Exactly the file the diff was computed against (GitHub's merge base),
 * which the base branch's tip need not be. Null when the new file does not match the
 * patch (another commit, or a cut copy).
 */
export function oldFromNew(fd: FileDiffMetadata, newContents: string): string | null {
  const neu = splitLines(newContents);
  const old: string[] = [];
  let at = 0;
  for (const h of fd.hunks) {
    const start = sideStart(h.additionStart, h.additionCount);
    if (start < at || start + h.additionCount > neu.length) return null;
    old.push(...neu.slice(at, start));
    if (old.length !== sideStart(h.deletionStart, h.deletionCount)) return null;
    for (let i = 0; i < h.additionCount; i++) {
      if (neu[start + i] !== fd.additionLines[h.additionLineIndex + i]) return null;
    }
    old.push(...fd.deletionLines.slice(h.deletionLineIndex, h.deletionLineIndex + h.deletionCount));
    at = start + h.additionCount;
  }
  old.push(...neu.slice(at));
  return old.join("");
}

/** Why a file cannot expand; thrown by the loader, shown by the caller. */
export class ExpandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExpandError";
  }
}

/**
 * The library's loadDiffFiles for a pull request: one read of the file at the head commit
 * (from the head repository), the old side rebuilt from it (oldFromNew), so expanding a
 * file costs one paced GitHub request and never drifts from the patch. Only changed and
 * renamed files ask (added and deleted ones carry their whole side).
 */
export function prFileLoader(repoSlug: string, headSha: string, read: (repoSlug: string, ref: string, path: string) => Promise<PullRequestFileView>): FileDiffContentsLoader {
  return async (fd): Promise<FileDiffLoadedFiles> => {
    if (!headSha) throw new ExpandError("the head commit is not known yet");
    const f = await read(repoSlug, headSha, fd.name);
    if (f.notFound) throw new ExpandError("the file is not in the head commit");
    if (f.binary) throw new ExpandError("the file is binary");
    if (f.truncated) throw new ExpandError("the file is over 1 MiB");
    const newFile = { name: fd.name, contents: f.contents, cacheKey: `${headSha}:${fd.name}` };
    if (fd.type === "rename-pure") return { oldFile: null, newFile };
    const old = oldFromNew(fd, f.contents);
    if (old === null) throw new ExpandError("the head copy does not match the diff");
    return { oldFile: { name: fd.prevName ?? fd.name, contents: old }, newFile };
  };
}
