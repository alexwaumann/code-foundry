/**
 * The patch preview's model (docs/notes/file-previews-5-patch.md): a `.patch` / `.diff`
 * file split into commits (a `git format-patch` mailbox, `git show` / `git log -p` output, or
 * none) and each commit into one section per file. Our own parsing is only the splitting and
 * the commit header; each file's diff is the library's (@pierre/diffs `processFile`), as the
 * Diff tab and the PR Code tab use it. Pure.
 */
import { processFile, type FileDiffMetadata } from "@pierre/diffs";

/** A commit's header: format-patch's mail headers, or `git show`'s. Missing parts are "". */
export interface PatchCommitHeader {
  sha: string;
  author: string;
  /** As the patch has it (RFC 2822 or git's default format). */
  date: string;
  /** `[PATCH n/m]` stripped. */
  subject: string;
  /** The message after the subject, trimmed ("" when there is none). */
  body: string;
}

export type PatchFileStatus = "added" | "deleted" | "renamed" | "copied" | "modified";

export interface PatchFile {
  /** Unique within the patch: the CodeView item's id. */
  id: string;
  /** The library's metadata; null when nothing in the section parses as a diff. */
  fileDiff: FileDiffMetadata | null;
  path: string;
  /** A rename's or copy's source; "" otherwise. */
  prevPath: string;
  status: PatchFileStatus;
  added: number;
  deleted: number;
  binary: boolean;
  /** A file mode change (`old mode` / `new mode`), with or without content changes. */
  mode: { from: string; to: string } | null;
  /** What shows instead of a diff, when there is none to show ("Binary file"). */
  note: string | null;
  /** What did not parse (a hunk cut short): the section shows what did. */
  problem: string | null;
  /** Rows of the diff when unified. */
  lines: number;
}

export interface PatchCommit {
  header: PatchCommitHeader | null;
  files: PatchFile[];
}

export interface PatchModel {
  commits: PatchCommit[];
  /** Every commit's files, in order. */
  files: PatchFile[];
  added: number;
  deleted: number;
  /** Sections with a problem. */
  problems: number;
}

const FORMAT_PATCH_START = /^From ([0-9a-f]{7,64}) /;
const GIT_LOG_START = /^commit ([0-9a-f]{7,64})\b/;
const HUNK = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/** The text's lines without their line ends. */
function linesOf(text: string): string[] {
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l.endsWith("\r")) lines[i] = l.slice(0, -1);
  }
  return lines;
}

/** Indexes of the lines that start a commit (format-patch's `From <sha>`, git log's `commit <sha>`). */
function commitStarts(lines: readonly string[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if ((l.startsWith("From ") && FORMAT_PATCH_START.test(l)) || (l.startsWith("commit ") && GIT_LOG_START.test(l))) out.push(i);
  }
  return out;
}

/**
 * Indexes of the lines that start a file's section. With any `diff --git` line, those; else a
 * `---` line followed by a `+++` line outside a hunk (plain `diff -u`), moved up one line onto a
 * `diff …` command line just above it (`diff -ru`). Hunk bodies are skipped by their counts, so
 * a removed line that reads `-- x` does not start a file.
 */
export function fileStarts(lines: readonly string[], from = 0, to = lines.length): number[] {
  const git: number[] = [];
  for (let i = from; i < to; i++) if ((lines[i] ?? "").startsWith("diff --git ")) git.push(i);
  if (git.length > 0) return git;
  const out: number[] = [];
  let open = false;
  let old = 0;
  let neu = 0;
  for (let i = from; i < to; i++) {
    const l = lines[i] ?? "";
    if (old > 0 || neu > 0) {
      const c = l[0];
      if (c === "\\") continue;
      // An empty line is a context line whose space an editor stripped.
      if (c === " " || l === "") {
        old--;
        neu--;
        continue;
      }
      if (c === "-") {
        old--;
        continue;
      }
      if (c === "+") {
        neu--;
        continue;
      }
      // The hunk was cut short: this line is something else.
      old = 0;
      neu = 0;
    }
    if (l.startsWith("--- ") && (lines[i + 1] ?? "").startsWith("+++ ")) {
      out.push(i > from && (lines[i - 1] ?? "").startsWith("diff ") ? i - 1 : i);
      open = true;
      i++;
      continue;
    }
    if (open && l.startsWith("@@ ")) {
      const m = HUNK.exec(l);
      if (m) {
        old = m[1] === undefined ? 1 : Number(m[1]);
        neu = m[2] === undefined ? 1 : Number(m[2]);
      }
    }
  }
  return out;
}

/** RFC 2047 encoded words (`=?UTF-8?q?caf=C3=A9?=`), as git writes non-ASCII names and subjects. */
export function decodeMimeWords(s: string): string {
  if (!s.includes("=?")) return s;
  return s.replace(/=\?([^?]+)\?([bqBQ])\?([^?]*)\?=(\s+(?==\?))?/g, (whole, charset: string, enc: string, data: string) => {
    try {
      let bytes: Uint8Array;
      if (enc.toLowerCase() === "b") {
        bytes = Uint8Array.from(atob(data), (c) => c.charCodeAt(0));
      } else {
        const raw = data.replace(/_/g, " ");
        const out: number[] = [];
        for (let i = 0; i < raw.length; i++) {
          const hex = raw.slice(i + 1, i + 3);
          if (raw[i] === "=" && /^[0-9a-fA-F]{2}$/.test(hex)) {
            out.push(parseInt(hex, 16));
            i += 2;
          } else out.push(raw.charCodeAt(i));
        }
        bytes = Uint8Array.from(out);
      }
      return new TextDecoder(charset).decode(bytes);
    } catch {
      return whole;
    }
  });
}

/** `"Doe, Jane" <jane@x.org>` → `Doe, Jane`; a bare address stays. */
function personOf(s: string): string {
  const v = decodeMimeWords(s.trim());
  const m = /^(.*?)\s*<([^>]*)>\s*$/.exec(v);
  if (!m) return v;
  const name = (m[1] ?? "").replace(/^"(.*)"$/, "$1").trim();
  return name || (m[2] ?? "");
}

/** `[PATCH v2 3/7] subject` → `subject`; `[RFC PATCH]` too. */
export function stripPatchPrefix(subject: string): string {
  return subject.replace(/^\s*\[[^\]]*\bPATCH\b[^\]]*\]\s*/i, "");
}

/** A format-patch mail header: `From <sha> …`, then From/Date/Subject (folded lines joined), a blank line, the body up to `---`. */
function mailHeader(lines: readonly string[], sha: string): PatchCommitHeader {
  const fields = new Map<string, string>();
  let i = 1;
  let last = "";
  for (; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l === "") {
      i++;
      break;
    }
    if ((l.startsWith(" ") || l.startsWith("\t")) && last) {
      fields.set(last, `${fields.get(last) ?? ""} ${l.trim()}`);
      continue;
    }
    const colon = l.indexOf(":");
    if (colon < 1) break;
    last = l.slice(0, colon).toLowerCase();
    fields.set(last, l.slice(colon + 1).trim());
  }
  const body: string[] = [];
  for (; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l === "---") break;
    body.push(l);
  }
  return {
    sha,
    author: personOf(fields.get("from") ?? ""),
    date: fields.get("date") ?? "",
    subject: stripPatchPrefix(decodeMimeWords(fields.get("subject") ?? "")).trim(),
    body: body.join("\n").trim(),
  };
}

/** `git show` / `git log -p`: `commit <sha>`, `Author:`, `Date:`, a blank line, the message indented four spaces. */
function logHeader(lines: readonly string[], sha: string): PatchCommitHeader {
  let author = "";
  let date = "";
  let i = 1;
  for (; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (l === "") break;
    if (l.startsWith("Author:")) author = personOf(l.slice(7));
    else if (l.startsWith("Date:")) date = l.slice(5).trim();
  }
  const message = lines
    .slice(i + 1)
    .map((l) => (l.startsWith("    ") ? l.slice(4) : l))
    .join("\n")
    .trim();
  const nl = message.indexOf("\n");
  return { sha, author, date, subject: nl < 0 ? message : message.slice(0, nl).trim(), body: nl < 0 ? "" : message.slice(nl + 1).trim() };
}

const STATUS: Record<FileDiffMetadata["type"], PatchFileStatus> = {
  new: "added",
  deleted: "deleted",
  change: "modified",
  "rename-pure": "renamed",
  "rename-changed": "renamed",
};

/** The library's error without its function name: "parsePatchContent: hunk line count mismatch" → "hunk line count mismatch". */
function problemOf(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/^[A-Za-z]+:\s*/, "");
}

/** One file's section: the library parses it; we add what it leaves out (binary, status of a plain diff, copies). */
function fileOf(section: string, git: boolean, id: string): PatchFile | null {
  let problem: string | null = null;
  let fd: FileDiffMetadata | undefined;
  try {
    fd = processFile(section, { isGitDiff: git, throwOnError: true });
  } catch (err) {
    problem = problemOf(err);
    try {
      // Best effort: the library repairs what it can (it logs what it could not).
      fd = processFile(section, { isGitDiff: git, throwOnError: false });
    } catch {
      fd = undefined;
    }
  }
  // The header lines, up to the first hunk.
  const hunkAt = section.indexOf("\n@@ ");
  const head = hunkAt < 0 ? section : section.slice(0, hunkAt);
  const binary = /^(?:Binary files .* differ|GIT binary patch)$/m.test(head);
  if (!fd) {
    const name = /^(?:\+\+\+|---) (?:[ab]\/)?([^\t\n]+)/m.exec(head)?.[1] ?? /^diff --git a\/(\S+)/m.exec(head)?.[1] ?? "";
    return { id, fileDiff: null, path: name, prevPath: "", status: "modified", added: 0, deleted: 0, binary, mode: null, note: binary ? "Binary file" : "Nothing here parses as a diff", problem: problem ?? "no diff", lines: 0 };
  }
  if (!git) {
    // A plain diff names both sides and says nothing of renames: different names are the
    // same file (`foo.c.orig` and `foo.c`), and /dev/null is the side that is not there.
    const added = /^--- \/dev\/null/m.test(head);
    const deleted = /^\+\+\+ \/dev\/null/m.test(head);
    fd.type = added ? "new" : deleted ? "deleted" : "change";
    fd.prevName = undefined;
  }
  let status = STATUS[fd.type];
  if (status === "renamed" && /^copy from /m.test(head)) status = "copied";
  let added = 0;
  let deleted = 0;
  let lines = 0;
  for (const h of fd.hunks) {
    added += h.additionLines;
    deleted += h.deletionLines;
    lines += h.unifiedLineCount;
  }
  const mode = fd.prevMode && fd.mode && fd.prevMode !== fd.mode ? { from: fd.prevMode, to: fd.mode } : null;
  let note: string | null = null;
  if (binary) note = "Binary file";
  else if (fd.hunks.length === 0) {
    if (mode) note = `Mode ${mode.from} → ${mode.to}`;
    else if (status === "renamed" || status === "copied") note = "Contents unchanged";
    else if (status === "added") note = "Empty file";
    else if (status === "deleted") note = "Was empty";
    else {
      note = "Nothing here parses as a diff";
      problem ??= "no hunks";
    }
  }
  return {
    id,
    fileDiff: fd,
    path: fd.name,
    prevPath: fd.prevName ?? "",
    status,
    added,
    deleted,
    binary,
    mode,
    note,
    problem,
    lines,
  };
}

/**
 * A file's section as the library reads it, forgiving what git apply and GNU patch forgive: an
 * empty line inside a hunk is a context line whose space an editor stripped, and after the
 * last hunk ends (by its counts) what follows is not the file's (format-patch's `-- ` and
 * git version, `Only in …` from diff -r) and is left out.
 */
export function sectionText(lines: readonly string[], from: number, to: number): string {
  const out: string[] = [];
  let old = 0;
  let neu = 0;
  let hunks = 0;
  for (let i = from; i < to; i++) {
    const l = lines[i] ?? "";
    if (old > 0 || neu > 0) {
      const c = l[0];
      if (c === "\\") {
        out.push(l);
        continue;
      }
      if (c === " " || l === "") {
        old--;
        neu--;
        out.push(l === "" ? " " : l);
        continue;
      }
      if (c === "-" || c === "+") {
        if (c === "-") old--;
        else neu--;
        out.push(l);
        continue;
      }
      old = 0;
      neu = 0;
    }
    if (l.startsWith("@@ ")) {
      const m = HUNK.exec(l);
      if (m) {
        hunks++;
        old = m[1] === undefined ? 1 : Number(m[1]);
        neu = m[2] === undefined ? 1 : Number(m[2]);
      }
      out.push(l);
      continue;
    }
    if (hunks > 0) {
      // Past a hunk's end: more hunk lines are the library's to flag (a wrong count); a
      // signature or anything else is not this file's.
      if (l === "-- " || l === "--" || !(l[0] === " " || l[0] === "+" || l[0] === "-")) break;
    }
    out.push(l);
  }
  return out.join("\n") + "\n";
}

/** One commit's lines (its header, if any, first): the header and its files. */
function commitOf(lines: readonly string[], index: number): PatchCommit {
  const first = lines[0] ?? "";
  const fmt = FORMAT_PATCH_START.exec(first);
  const log = fmt ? null : GIT_LOG_START.exec(first);
  const starts = fileStarts(lines);
  const headEnd = starts[0] ?? lines.length;
  let header: PatchCommitHeader | null = null;
  if (fmt) header = mailHeader(lines.slice(0, headEnd), fmt[1] ?? "");
  else if (log) header = logHeader(lines.slice(0, headEnd), log[1] ?? "");
  const git = starts.length > 0 && (lines[starts[0] ?? 0] ?? "").startsWith("diff --git ");
  const files: PatchFile[] = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s] ?? 0;
    const to = starts[s + 1] ?? lines.length;
    const f = fileOf(sectionText(lines, from, to), git, `${String(index)}:${String(s)}`);
    if (f) files.push(f);
  }
  return { header, files };
}

/** Parses a patch or diff file: its commits (or one without a header) and their files. Never throws. */
export function parsePatch(text: string): PatchModel {
  const lines = linesOf(text);
  if (lines.at(-1) === "") lines.pop();
  const starts = commitStarts(lines);
  const bounds = starts[0] === 0 ? starts : [0, ...starts];
  const commits: PatchCommit[] = [];
  for (let c = 0; c < bounds.length; c++) {
    const part = lines.slice(bounds[c], bounds[c + 1] ?? lines.length);
    const commit = commitOf(part, c);
    // Text before the first commit that holds no diff (a mail's preamble) is not a commit.
    if (!commit.header && commit.files.length === 0) continue;
    commits.push(commit);
  }
  const files = commits.flatMap((c) => c.files);
  let added = 0;
  let deleted = 0;
  let problems = 0;
  for (const f of files) {
    added += f.added;
    deleted += f.deleted;
    if (f.problem) problems++;
  }
  return { commits, files, added, deleted, problems };
}

let cached: { text: string; model: PatchModel } | null = null;

/** parsePatch, remembered for the last text: the meta line and the body read the same model. */
export function patchModelOf(text: string): PatchModel {
  if (cached?.text !== text) cached = { text, model: parsePatch(text) };
  return cached.model;
}

/** "a4a92c61b0…" → "a4a92c6". */
export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** A commit's date as "Nov 13, 2026"; the text as it is when it is not a date. */
export function commitDate(raw: string): string {
  if (!raw) return "";
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return raw;
  return new Date(ms).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}
