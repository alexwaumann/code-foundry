import { ProjectService, type WorktreeDetail } from "@/gen/codefoundry/v1/project_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { ms } from "./timestamp";

/** One changed path. `status` is a git letter (A M D R C T U) or "?" for untracked. */
export interface FileChangeView {
  path: string;
  oldPath: string;
  status: string;
  added: number;
  deleted: number;
  binary: boolean;
  uncommitted: boolean;
}

/** ProjectService.GetWorktreeDetail: a worktree against its base. */
export interface WorktreeDetailView {
  projectId: string;
  path: string;
  baseRef: string;
  mergeBase: string;
  head: string;
  files: FileChangeView[];
  filesTruncated: boolean;
  computedAtMs: number | null;
  error: string;
}

export function toWorktreeDetailView(d: WorktreeDetail): WorktreeDetailView {
  return {
    projectId: d.projectId,
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
    })),
    filesTruncated: d.filesTruncated,
    computedAtMs: ms(d.computedAt),
    error: d.error,
  };
}

export async function getWorktreeDetail(projectId: string, path: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<WorktreeDetailView> {
  const c = await conn.client(ProjectService);
  const r = await c.getWorktreeDetail({ projectId, path }, { signal });
  if (!r.detail) throw new Error("GetWorktreeDetail returned no detail");
  return toWorktreeDetailView(r.detail);
}
