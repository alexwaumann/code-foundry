import { timestampMs } from "@bufbuild/protobuf/wkt";
import { RepoService, type WorktreeDetail } from "@/gen/codefoundry/v1/repo_pb";
import { daemon, type DaemonConnection } from "./endpoint";

/** One changed path. `status` is a git letter (A M D R C T U) or "?" for untracked. */
export interface FileChangeView {
  path: string;
  oldPath: string;
  status: string;
  added: number;
  deleted: number;
  binary: boolean;
  uncommitted: boolean;
  isDir: boolean;
}

export interface LogEntryView {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authoredAtMs: number | null;
}

/** RepoService.GetWorktreeDetail: a worktree against its base. */
export interface WorktreeDetailView {
  repoId: string;
  path: string;
  baseRef: string;
  mergeBase: string;
  head: string;
  files: FileChangeView[];
  filesTruncated: boolean;
  log: LogEntryView[];
  logTotal: number;
  computedAtMs: number | null;
  error: string;
}

export function toWorktreeDetailView(d: WorktreeDetail): WorktreeDetailView {
  return {
    repoId: d.repoId,
    path: d.path,
    baseRef: d.baseRef,
    mergeBase: d.mergeBase,
    head: d.head,
    files: d.files.map((f) => ({
      path: f.path,
      oldPath: f.oldPath,
      status: f.status,
      added: f.added,
      deleted: f.deleted,
      binary: f.binary,
      uncommitted: f.uncommitted,
      isDir: f.isDir,
    })),
    filesTruncated: d.filesTruncated,
    log: d.log.map((l) => ({
      sha: l.sha,
      shortSha: l.shortSha,
      subject: l.subject,
      authorName: l.authorName,
      authorEmail: l.authorEmail,
      authoredAtMs: l.authoredAt ? timestampMs(l.authoredAt) : null,
    })),
    logTotal: d.logTotal,
    computedAtMs: d.computedAt ? timestampMs(d.computedAt) : null,
    error: d.error,
  };
}

export async function getWorktreeDetail(repoId: string, path: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<WorktreeDetailView> {
  const c = await conn.client(RepoService);
  const r = await c.getWorktreeDetail({ repoId, path }, { signal });
  if (!r.detail) throw new Error("GetWorktreeDetail returned no detail");
  return toWorktreeDetailView(r.detail);
}
