import { timestampMs } from "@bufbuild/protobuf/wkt";
import {
  RepoService,
  type GitStatus,
  type Repo,
  type RepoEvent,
  type Worktree,
} from "@/gen/codefoundry/v1/repo_pb";
import { daemon, type DaemonConnection } from "./endpoint";

export interface GitStatusView {
  upstream: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  dirty: boolean;
  refreshedAtMs: number | null;
  /** Remote-tracking default branch HEAD is compared with ("origin/main"); "" when none. */
  baseRef?: string;
  baseAhead?: number;
  baseBehind?: number;
  /** Last status refresh error ("" when fine). */
  error?: string;
}

export interface WorktreeView {
  repoId: string;
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
  status: GitStatusView;
}

export interface RepoView {
  id: string;
  path: string;
  name: string;
  defaultBranch: string;
  githubSlug: string;
  worktrees: WorktreeView[];
}

export type RepoEventView =
  | { kind: "snapshot"; repos: RepoView[] }
  | { kind: "repoUpdated"; repo: RepoView }
  | { kind: "repoRemoved"; id: string }
  | { kind: "worktreeUpdated"; worktree: WorktreeView }
  | { kind: "worktreeRemoved"; repoId: string; path: string }
  /** The worktree's detail changed (see api/worktreeDetail.ts); repo state is unchanged. */
  | { kind: "worktreeDetailUpdated"; repoId: string; path: string };

const cleanStatus: GitStatusView = {
  upstream: "",
  ahead: 0,
  behind: 0,
  staged: 0,
  modified: 0,
  untracked: 0,
  dirty: false,
  refreshedAtMs: null,
  baseRef: "",
  baseAhead: 0,
  baseBehind: 0,
  error: "",
};

export function toGitStatusView(s: GitStatus | undefined): GitStatusView {
  if (!s) return cleanStatus;
  return {
    upstream: s.upstream,
    ahead: s.ahead,
    behind: s.behind,
    staged: s.staged,
    modified: s.modified,
    untracked: s.untracked,
    dirty: s.dirty,
    refreshedAtMs: s.refreshedAt ? timestampMs(s.refreshedAt) : null,
    baseRef: s.baseRef,
    baseAhead: s.baseAhead,
    baseBehind: s.baseBehind,
    error: s.error,
  };
}

export function toWorktreeView(w: Worktree): WorktreeView {
  return { repoId: w.repoId, path: w.path, branch: w.branch, head: w.head, isMain: w.isMain, status: toGitStatusView(w.status) };
}

export function toRepoView(r: Repo): RepoView {
  return {
    id: r.id,
    path: r.path,
    name: r.name,
    defaultBranch: r.defaultBranch,
    githubSlug: r.githubSlug,
    worktrees: r.worktrees.map(toWorktreeView),
  };
}

export function toRepoEventView(ev: RepoEvent): RepoEventView | null {
  const e = ev.event;
  switch (e.case) {
    case "snapshot":
      return { kind: "snapshot", repos: e.value.repos.map(toRepoView) };
    case "repoUpdated":
      return { kind: "repoUpdated", repo: toRepoView(e.value) };
    case "repoRemovedId":
      return { kind: "repoRemoved", id: e.value };
    case "worktreeUpdated":
      return { kind: "worktreeUpdated", worktree: toWorktreeView(e.value) };
    case "worktreeRemoved":
      return { kind: "worktreeRemoved", repoId: e.value.repoId, path: e.value.path };
    case "worktreeDetailUpdated":
      return { kind: "worktreeDetailUpdated", repoId: e.value.repoId, path: e.value.path };
    default:
      return null;
  }
}

export async function listRepos(conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<RepoView[]> {
  const c = await conn.client(RepoService);
  const res = await c.list({}, { signal });
  return res.repos.map(toRepoView);
}
