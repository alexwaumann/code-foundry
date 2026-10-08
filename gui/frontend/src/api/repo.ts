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
  | { kind: "repoUpdated"; repo: RepoView }
  | { kind: "repoRemoved"; id: string }
  | { kind: "worktreeUpdated"; worktree: WorktreeView }
  | { kind: "worktreeRemoved"; repoId: string; path: string };

const cleanStatus: GitStatusView = {
  upstream: "",
  ahead: 0,
  behind: 0,
  staged: 0,
  modified: 0,
  untracked: 0,
  dirty: false,
  refreshedAtMs: null,
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
    case "repoUpdated":
      return { kind: "repoUpdated", repo: toRepoView(e.value) };
    case "repoRemovedId":
      return { kind: "repoRemoved", id: e.value };
    case "worktreeUpdated":
      return { kind: "worktreeUpdated", worktree: toWorktreeView(e.value) };
    case "worktreeRemoved":
      return { kind: "worktreeRemoved", repoId: e.value.repoId, path: e.value.path };
    default:
      return null;
  }
}

export async function listRepos(conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<RepoView[]> {
  const c = await conn.client(RepoService);
  const res = await c.list({}, { signal });
  return res.repos.map(toRepoView);
}

export async function* watchRepos(signal: AbortSignal, conn: DaemonConnection = daemon): AsyncGenerator<RepoEventView> {
  const c = await conn.client(RepoService);
  for await (const ev of c.watch({}, { signal })) {
    const v = toRepoEventView(ev);
    if (v) yield v;
  }
}
