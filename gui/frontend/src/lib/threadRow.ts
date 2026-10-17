/**
 * What a sidebar thread row shows besides its name and status: the project it runs in,
 * the branch there, the owning workspace (the badge), and a queued "Run in…" move. Pure,
 * over the projects and workspaces slices.
 */
import type { ThreadView } from "@/api/threads";
import type { WorkspaceView } from "@/api/workspace";
import type { Choice } from "./compose";
import { modelName } from "./models";
import { basename, isWithin } from "./path";

/** The slices of the projects store these helpers read. */
export interface ProjectLookup {
  /** `git` false: a project without git, whose checkout has no branch (absent counts as git). */
  byId: Readonly<Record<string, { name: string; git?: boolean; worktrees: readonly { path: string; branch: string; head: string; isMain?: boolean }[] } | undefined>>;
}


/** Whether projectId is a known project without git. */
export function isNoGit(projects: ProjectLookup, projectId: string): boolean {
  return projects.byId[projectId]?.git === false;
}

/** What a thread without a project shows where a project name would be (with the House icon). */
export const NO_PROJECT = "No project";

/**
 * A thread without a project (docs/notes/no-project-1-daemon.md): no workspace, no project
 * id, and a cwd (the daemon's home directory) inside no known project's worktree. Older
 * rows with an empty project id whose path is inside a project are placed by their path
 * instead, so they are not this.
 */
export function isNoProject(s: Pick<ThreadView, "projectId" | "workspaceId" | "worktreePath">, projects: ProjectLookup): boolean {
  if (s.projectId || s.workspaceId) return false;
  for (const r of Object.values(projects.byId)) if (r?.worktrees.some((w) => isWithin(s.worktreePath, w.path))) return false;
  return true;
}

export interface WorkspaceLookup {
  byId: Readonly<Record<string, Pick<WorkspaceView, "name" | "members"> | undefined>>;
}

export interface ThreadRowModel {
  /** The cwd's project name (the project id when unknown); NO_PROJECT for a thread without one. */
  project: string;
  /** A thread without a project (isNoProject): no branch, no worktree, the House icon. */
  noProject: boolean;
  /** The branch checked out in the cwd: branch, else the short head, else the directory name; "" without git. */
  branch: string;
  /** The cwd's project is not a git repository: show the No git badge instead of a branch. */
  noGit: boolean;
  /** The owning workspace's name; null for a project thread. */
  workspace: string | null;
  /** Project name of the member a queued Run in moves the thread to; null when none is queued. */
  movingTo: string | null;
  /** The cwd is a linked worktree, not the project's main checkout (false when unknown or without git). */
  worktree: boolean;
}

/**
 * Branch label for a worktree: its branch, else the short head (detached), else the
 * directory name. "" for a project without git, which has no branch to show.
 */
export function worktreeBranch(projects: ProjectLookup, projectId: string, path: string): string {
  if (isNoGit(projects, projectId)) return "";
  const w = projects.byId[projectId]?.worktrees.find((x) => x.path === path);
  return w?.branch || (w?.head ? w.head.slice(0, 7) : basename(path));
}

/**
 * The project a worktree path belongs to, by name: a project whose worktrees include it,
 * else one with a worktree containing it (an older thread row with no project id), else the
 * directory name.
 */
export function projectOfPath(projects: ProjectLookup, path: string): string {
  const all = Object.values(projects.byId);
  for (const r of all) if (r?.worktrees.some((w) => w.path === path)) return r.name;
  for (const r of all) if (r?.worktrees.some((w) => isWithin(path, w.path))) return r.name;
  return basename(path);
}

/** The project name a workspace member path belongs to, preferring the workspace's own member list. */
export function memberName(projects: ProjectLookup, workspace: Pick<WorkspaceView, "members"> | undefined, path: string): string {
  const m = workspace?.members.find((x) => x.worktreePath === path);
  const name = m ? projects.byId[m.projectId]?.name : undefined;
  return name ?? projectOfPath(projects, path);
}

export function threadRowModel(
  s: Pick<ThreadView, "projectId" | "worktreePath" | "workspaceId" | "pendingWorktreePath">,
  projects: ProjectLookup,
  workspaces: WorkspaceLookup,
): ThreadRowModel {
  if (isNoProject(s, projects)) return { project: NO_PROJECT, noProject: true, branch: "", noGit: false, workspace: null, movingTo: null, worktree: false };
  const ws = s.workspaceId ? workspaces.byId[s.workspaceId] : undefined;
  return {
    noProject: false,
    project: projects.byId[s.projectId]?.name ?? (s.projectId || projectOfPath(projects, s.worktreePath)),
    branch: worktreeBranch(projects, s.projectId, s.worktreePath),
    noGit: isNoGit(projects, s.projectId),
    // A workspace the slice does not know (older daemon, or just removed) still badges the row.
    workspace: s.workspaceId ? (ws?.name ?? s.workspaceId) : null,
    movingTo: s.pendingWorktreePath && s.pendingWorktreePath !== s.worktreePath ? memberName(projects, ws, s.pendingWorktreePath) : null,
    worktree: !isNoGit(projects, s.projectId) && projects.byId[s.projectId]?.worktrees.find((w) => w.path === s.worktreePath)?.isMain === false,
  };
}

/** The model as the thread tooltip names it: its registry label, else the raw id; "Default" when unset. */
export function modelLabel(model: string, models: readonly Choice[]): string {
  const m = model.trim();
  return m ? modelName(models, m) : "Default";
}
