import { timestampMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { GhService, type GetPullRequestDiffResponse, type GetPullRequestFileResponse } from "@/gen/codefoundry/v1/gh_pb";
import { daemon, type DaemonConnection } from "./endpoint";

/** A pull request's unified diff as GitHub renders it (GhService.GetPullRequestDiff). */
export interface PullRequestDiffView {
  /** "diff --git a/… b/…" per file; cut at a line boundary when truncated. */
  diff: string;
  /** The head and base commits the diff was computed for; "" when the daemon had no detail cached. */
  headSha: string;
  baseSha: string;
  /** Over the daemon's 4 MiB cap: diff holds its first whole lines. */
  truncated: boolean;
  fetchedAtMs: number | null;
}

export function toPullRequestDiffView(r: GetPullRequestDiffResponse): PullRequestDiffView {
  return { diff: r.diff, headSha: r.headSha, baseSha: r.baseSha, truncated: r.truncated, fetchedAtMs: r.fetchedAt ? timestampMs(r.fetchedAt) : null };
}

const TOO_LARGE_PREFIX = "too large: ";

/** Whether a diff read's error message is GitHub refusing the diff (FAILED_PRECONDITION: over its limits). */
export function isTooLargeMessage(message: string | null | undefined): boolean {
  return (message ?? "").startsWith(TOO_LARGE_PREFIX);
}

/** The message without the too-large marker, for showing. */
export function tooLargeText(message: string): string {
  return message.startsWith(TOO_LARGE_PREFIX) ? message.slice(TOO_LARGE_PREFIX.length) : message;
}

/**
 * Reads a pull request's diff. refresh fetches from GitHub even when the daemon has the
 * diff of the cached head. GitHub's refusal of a diff over its limits (FAILED_PRECONDITION)
 * throws a message isTooLargeMessage recognises (the resource keeps only the message).
 */
export async function getPullRequestDiff(
  repoSlug: string,
  number: number,
  refresh = false,
  conn: DaemonConnection = daemon,
  signal?: AbortSignal,
): Promise<PullRequestDiffView> {
  const c = await conn.client(GhService);
  try {
    return toPullRequestDiffView(await c.getPullRequestDiff({ repoSlug, number, refresh }, { signal }));
  } catch (err) {
    if (err instanceof ConnectError && err.code === Code.FailedPrecondition) throw new Error(TOO_LARGE_PREFIX + err.rawMessage, { cause: err });
    throw err;
  }
}

/** One file at a commit (GhService.GetPullRequestFile), decoded as UTF-8. */
export interface PullRequestFileView {
  contents: string;
  /** Over 1 MiB: contents holds the first MiB. */
  truncated: boolean;
  binary: boolean;
  /** No file at that path in that commit (or a directory). */
  notFound: boolean;
}

export function toPullRequestFileView(r: GetPullRequestFileResponse): PullRequestFileView {
  const text = r.binary || r.notFound ? "" : new TextDecoder().decode(r.contents);
  return { contents: text, truncated: r.truncated, binary: r.binary, notFound: r.notFound };
}

/** Reads path at the full commit SHA ref from repoSlug (the head repository for a pull request's head side). */
export async function getPullRequestFile(repoSlug: string, ref: string, path: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<PullRequestFileView> {
  const c = await conn.client(GhService);
  return toPullRequestFileView(await c.getPullRequestFile({ repoSlug, ref, path }, { signal }));
}
