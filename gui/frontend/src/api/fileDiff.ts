import { DiffScope, ProjectService, type FileVersion, type GetWorktreeFileDiffResponse } from "@/gen/codefoundry/v1/project_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { orOutdatedDaemon } from "./errors";

/**
 * What a worktree file diff compares: `working` the merge base with the file on disk (the
 * Changes tab's list), `branch` the merge base with HEAD.
 */
export type DiffScopeView = "working" | "branch";

/** One side of a worktree file diff. */
export interface FileSideView {
  /** The file exists on this side (absent: an added file's old side, a deleted file's new side). */
  present: boolean;
  /** The decoded contents (UTF-8, invalid bytes as U+FFFD); "" for a binary or absent side. */
  text: string;
  /** Larger than 1 MiB: text holds its first MiB. */
  truncated: boolean;
  binary: boolean;
}

/** ProjectService.GetWorktreeFileDiff as the Diff tab shows it. */
export interface FileDiffView {
  old: FileSideView;
  new: FileSideView;
  /** "origin/main"; "" without a base (working is then against HEAD). */
  baseRef: string;
  mergeBase: string;
  head: string;
  /** A, D, M, R, or "" (the sides are equal, or neither exists). */
  status: string;
  /** Set when the scope cannot be compared (branch without a base); the sides are then empty. */
  error: string;
}

export interface FileDiffRequest {
  projectId: string;
  /** The worktree's path. */
  worktree: string;
  /** Worktree-relative path of the new side. */
  file: string;
  /** Worktree-relative path of the old side of a rename or copy; "" for file. */
  oldPath?: string;
  scope: DiffScopeView;
}

const utf8 = new TextDecoder("utf-8");

function toSide(v: FileVersion | undefined): FileSideView {
  if (!v) return { present: false, text: "", truncated: false, binary: false };
  return { present: v.present, text: v.present && !v.binary ? utf8.decode(v.contents) : "", truncated: v.truncated, binary: v.binary };
}

export function toFileDiffView(r: GetWorktreeFileDiffResponse): FileDiffView {
  return { old: toSide(r.old), new: toSide(r.new), baseRef: r.baseRef, mergeBase: r.mergeBase, head: r.head, status: r.status, error: r.error };
}

export async function getWorktreeFileDiff(req: FileDiffRequest, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<FileDiffView> {
  const c = await conn.client(ProjectService);
  try {
    const res = await c.getWorktreeFileDiff(
      { projectId: req.projectId, path: req.worktree, file: req.file, oldPath: req.oldPath ?? "", scope: req.scope === "branch" ? DiffScope.BRANCH : DiffScope.WORKING },
      { signal },
    );
    return toFileDiffView(res);
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}
