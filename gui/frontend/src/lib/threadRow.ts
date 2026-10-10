/**
 * What a sidebar thread row shows besides its name and status: the project it runs in,
 * the branch there, the owning workspace (the badge), and a queued "Run in…" move. Pure,
 * over the repos and workspaces slices.
 */
import type { SessionView } from "@/api/session";
import type { WorkspaceView } from "@/api/workspace";
import { basename, tildify } from "./path";
import { placeTerminal } from "./tree";

/** The slices of the repos store these helpers read. */
export interface RepoLookup {
  /** `git` false: a project without git, whose checkout has no branch (absent counts as git). */
  byId: Readonly<Record<string, { name: string; git?: boolean; worktrees: readonly { path: string; branch: string; head: string }[] } | undefined>>;
}

/** What stands in for a branch in text (a terminal's place) for a project without git. */
export const NO_GIT_LABEL = "No git";

/** Whether repoId is a known project without git. */
export function isNoGit(repos: RepoLookup, repoId: string): boolean {
  return repos.byId[repoId]?.git === false;
}

export interface WorkspaceLookup {
  byId: Readonly<Record<string, Pick<WorkspaceView, "name" | "members"> | undefined>>;
}

export interface ThreadRowModel {
  /** The cwd's project name (the repo id when unknown). */
  project: string;
  /** The branch checked out in the cwd: branch, else the short head, else the directory name; "" without git. */
  branch: string;
  /** The cwd's project is not a git repository: show the No git badge instead of a branch. */
  noGit: boolean;
  /** The owning workspace's name; null for a project thread. */
  workspace: string | null;
  /** Project name of the member a queued Run in moves the thread to; null when none is queued. */
  movingTo: string | null;
}

/**
 * Branch label for a worktree: its branch, else the short head (detached), else the
 * directory name. "" for a project without git, which has no branch to show.
 */
export function worktreeBranch(repos: RepoLookup, repoId: string, path: string): string {
  if (isNoGit(repos, repoId)) return "";
  const w = repos.byId[repoId]?.worktrees.find((x) => x.path === path);
  return w?.branch || (w?.head ? w.head.slice(0, 7) : basename(path));
}

/** The project a worktree path belongs to, by name: a repo whose worktrees include it, else the directory name. */
export function projectOfPath(repos: RepoLookup, path: string): string {
  for (const r of Object.values(repos.byId)) if (r?.worktrees.some((w) => w.path === path)) return r.name;
  return basename(path);
}

/** The project name a workspace member path belongs to, preferring the workspace's own member list. */
export function memberName(repos: RepoLookup, workspace: Pick<WorkspaceView, "members"> | undefined, path: string): string {
  const m = workspace?.members.find((x) => x.worktreePath === path);
  const name = m ? repos.byId[m.repoId]?.name : undefined;
  return name ?? projectOfPath(repos, path);
}

export function threadRowModel(
  s: Pick<SessionView, "repoId" | "worktreePath" | "workspaceId" | "pendingWorktreePath">,
  repos: RepoLookup,
  workspaces: WorkspaceLookup,
): ThreadRowModel {
  const ws = s.workspaceId ? workspaces.byId[s.workspaceId] : undefined;
  return {
    project: repos.byId[s.repoId]?.name ?? (s.repoId || projectOfPath(repos, s.worktreePath)),
    branch: worktreeBranch(repos, s.repoId, s.worktreePath),
    noGit: isNoGit(repos, s.repoId),
    // A workspace the slice does not know (older daemon, or just removed) still badges the row.
    workspace: s.workspaceId ? (ws?.name ?? s.workspaceId) : null,
    movingTo: s.pendingWorktreePath && s.pendingWorktreePath !== s.worktreePath ? memberName(repos, ws, s.pendingWorktreePath) : null,
  };
}

/**
 * Where a terminal sits, for its sidebar row: "project · branch" of the worktree it is
 * placed in (labels.worktree, else the longest cwd prefix), else its cwd with ~.
 */
export function terminalPlace(repos: RepoLookup & { order: readonly string[] }, t: { cwd: string; worktreeLabel: string }): string {
  const worktrees = repos.order.flatMap((id) => repos.byId[id]?.worktrees.map((w) => ({ repoId: id, path: w.path })) ?? []);
  const w = placeTerminal(t, worktrees);
  if (!w) return tildify(t.cwd);
  const branch = isNoGit(repos, w.repoId) ? NO_GIT_LABEL : worktreeBranch(repos, w.repoId, w.path);
  return `${repos.byId[w.repoId]?.name ?? w.repoId} · ${branch}`;
}
