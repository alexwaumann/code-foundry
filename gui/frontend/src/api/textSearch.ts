import { Code, ConnectError } from "@connectrpc/connect";
import { FilesystemService, type SearchTextSummary, type TextFileMatch } from "@/gen/codefoundry/v1/filesystem_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { orOutdatedDaemon } from "./errors";
import type { FinderSourceView } from "./filesystem";
import { errorMessage } from "./stream";
import { codePointRanges, type TextRange } from "./threadSearch";

/**
 * FilesystemService.SearchText as the finder's Text mode shows it
 * (docs/notes/file-search-4-text-rpc.md, file-search-5-text-mode.md): the lines of a
 * thread's files that contain a text, grouped by file, streamed. Ranges come as code points
 * and are mapped to UTF-16 here, once.
 */

/** What to search for and how. */
export interface TextQueryView {
  query: string;
  /** Match case even for an all-lower-case query (smart case otherwise). */
  matchCase: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/** One matching line. */
export interface TextLineView {
  /** 1-based. */
  line: number;
  /** The line (cut to about 300 characters around its first match when longer). */
  text: string;
  /** Every match in `text`, UTF-16 offsets, end exclusive; empty matches dropped. */
  ranges: readonly TextRange[];
  /** `text` begins after the line's start / ends before its end: an ellipsis there. */
  cutStart: boolean;
  cutEnd: boolean;
}

/** A file with matching lines. */
export interface TextFileView {
  projectId: string;
  /** The checkout `path` is relative to (the source's path as sent). */
  checkout: string;
  /** Relative to the checkout, "/"-separated. */
  path: string;
  /** Git ignores it; an include pattern lists it. */
  ignored: boolean;
  /** At most 50, in line order. */
  lines: readonly TextLineView[];
  /** Matching lines in the file, counted to 999 (lineCountCapped: more). */
  lineCount: number;
  lineCountCapped: boolean;
}

/** How a search ended. */
export interface TextSummaryView {
  lines: number;
  files: number;
  /** Some matches were not sent (any of the next three). */
  truncated: boolean;
  fileCapped: boolean;
  totalCapped: boolean;
  timedOut: boolean;
  /** What smart case decided (or match case). */
  caseSensitive: boolean;
  elapsedMs: number;
}

export function toTextFileView(f: TextFileMatch): TextFileView {
  return {
    projectId: f.projectId,
    checkout: f.checkout,
    path: f.path,
    ignored: f.ignored,
    lines: f.lines.map((l) => ({ line: l.line, text: l.text, ranges: codePointRanges(l.text, l.ranges), cutStart: l.cutStart, cutEnd: l.cutEnd })),
    lineCount: f.lineCount,
    lineCountCapped: f.lineCountCapped,
  };
}

export function toTextSummaryView(s: SearchTextSummary): TextSummaryView {
  return {
    lines: s.lines,
    files: s.files,
    truncated: s.truncated,
    fileCapped: s.fileCapped,
    totalCapped: s.totalCapped,
    timedOut: s.timedOut,
    caseSensitive: s.caseSensitive,
    elapsedMs: Number(s.elapsedMs),
  };
}

/**
 * Why a search failed, as the finder shows it: `query` is the query's own fault (an invalid
 * regex, too long: InvalidArgument), said by the field; `unavailable` is ripgrep missing or
 * broken (FailedPrecondition), said in its own words; anything else is `other`.
 */
export interface TextSearchError {
  kind: "query" | "unavailable" | "other";
  message: string;
}

export function textSearchError(err: unknown): TextSearchError {
  const message = errorMessage(err);
  if (err instanceof ConnectError && err.code === Code.InvalidArgument) return { kind: "query", message };
  if (err instanceof ConnectError && err.code === Code.FailedPrecondition) return { kind: "unavailable", message };
  return { kind: "other", message };
}

/**
 * Searches the checkouts' files for the text: each message's files go to `onFiles` as they
 * arrive (in order, continuing the previous message's); the promise resolves with the
 * summary that ends the stream. Abort the signal to cancel (the daemon stops its ripgreps).
 * A daemon older than the RPC fails with OutdatedDaemonError.
 */
export async function searchText(
  req: { sources: readonly FinderSourceView[] } & TextQueryView,
  onFiles: (files: TextFileView[]) => void,
  signal?: AbortSignal,
  conn: DaemonConnection = daemon,
): Promise<TextSummaryView> {
  const c = await conn.client(FilesystemService);
  let summary: TextSummaryView | null = null;
  try {
    const stream = c.searchText({ sources: req.sources.map((s) => ({ projectId: s.projectId, path: s.path })), query: req.query, matchCase: req.matchCase, wholeWord: req.wholeWord, regex: req.regex }, { signal });
    for await (const res of stream) {
      if (res.files.length > 0) onFiles(res.files.map(toTextFileView));
      if (res.summary) summary = toTextSummaryView(res.summary);
    }
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
  return summary ?? { lines: 0, files: 0, truncated: false, fileCapped: false, totalCapped: false, timedOut: false, caseSensitive: false, elapsedMs: 0 };
}
