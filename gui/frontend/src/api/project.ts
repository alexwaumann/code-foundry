import { timestampMs } from "@bufbuild/protobuf/wkt";
import {
  ProjectService,
  type GitStatus,
  type Project,
  type ProjectEvent,
  type Worktree,
} from "@/gen/codefoundry/v1/project_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { orOutdatedDaemon } from "./errors";

export interface GitStatusView {
  upstream: string;
  ahead: number;
  behind: number;
  staged: number;
  modified: number;
  untracked: number;
  /** Unmerged (conflicted) entries; counted in dirty, not in staged or modified. */
  conflicted?: number;
  dirty: boolean;
  refreshedAtMs: number | null;
  /** Remote-tracking default branch HEAD is compared with ("origin/main"); "" when none. */
  baseRef?: string;
  baseAhead?: number;
  baseBehind?: number;
  /**
   * Git operation in progress: "" (none), "rebase", "am", "merge", "cherry-pick",
   * "revert" or "bisect". Read by the daemon from the worktree's git admin dir.
   */
  operation?: string;
  /** A rebase's (or am's) current patch, 1-based, and its last; 0 when unknown. */
  operationStep?: number;
  operationTotal?: number;
  /** Last status refresh error ("" when fine). */
  error?: string;
}

export interface WorktreeView {
  projectId: string;
  path: string;
  branch: string;
  head: string;
  /** HEAD is detached (branch is ""). */
  detached: boolean;
  isMain: boolean;
  status: GitStatusView;
  /**
   * The git half of "safe to clean up" (the daemon's project.MergedCleanReason): not main,
   * on a branch, nothing uncommitted, every commit in status.baseRef. Live threads,
   * terminals and workspaces are checked against their own slices (lib/projects.ts
   * isCleanable). Absent counts as false.
   */
  mergedClean?: boolean;
  /** Code Foundry made it (recorded when made); only these can be cleaned up. Absent counts as false. */
  managed?: boolean;
  /** HEAD's work is in status.baseRef (no commits ahead, or a rebased or squash-merged copy landed). Absent counts as false. */
  landed?: boolean;
  /** The daemon's cleanup reason: why the git half keeps it ("3 commits not in origin/main", "rebase in progress", …) or why it may go. */
  cleanupReason?: string;
}

export interface ProjectView {
  id: string;
  path: string;
  name: string;
  defaultBranch: string;
  githubSlug: string;
  /** Configured git remotes ("origin", …), sorted; empty for a local-only repository. */
  remotes: string[];
  /**
   * The project is a git repository. Without git it has one synthetic main worktree
   * (its folder) with an empty branch and head and a zero status, which nothing may
   * render as a real branch or status: show the "No git" state instead.
   */
  git: boolean;
  worktrees: WorktreeView[];
}

/**
 * A git repository with no remote (not one without git): offers Publish to GitHub.
 * Shown only once the project has been reconciled (it has a worktree).
 */
export function isRemoteless(r: Pick<ProjectView, "git" | "remotes" | "worktrees">): boolean {
  return r.git && r.remotes.length === 0 && r.worktrees.length > 0;
}

export type ProjectEventView =
  | { kind: "snapshot"; projects: ProjectView[] }
  | { kind: "projectUpdated"; project: ProjectView }
  | { kind: "projectRemoved"; id: string }
  | { kind: "worktreeUpdated"; worktree: WorktreeView }
  | { kind: "worktreeRemoved"; projectId: string; path: string }
  /** The worktree's detail changed (see api/worktreeDetail.ts); project state is unchanged. */
  | { kind: "worktreeDetailUpdated"; projectId: string; path: string };

const cleanStatus: GitStatusView = {
  upstream: "",
  ahead: 0,
  behind: 0,
  staged: 0,
  modified: 0,
  untracked: 0,
  conflicted: 0,
  dirty: false,
  refreshedAtMs: null,
  baseRef: "",
  baseAhead: 0,
  baseBehind: 0,
  operation: "",
  operationStep: 0,
  operationTotal: 0,
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
    conflicted: s.conflicted,
    dirty: s.dirty,
    refreshedAtMs: s.refreshedAt ? timestampMs(s.refreshedAt) : null,
    baseRef: s.baseRef,
    baseAhead: s.baseAhead,
    baseBehind: s.baseBehind,
    operation: s.operation,
    operationStep: s.operationStep,
    operationTotal: s.operationTotal,
    error: s.error,
  };
}

export function toWorktreeView(w: Worktree): WorktreeView {
  return { projectId: w.projectId, path: w.path, branch: w.branch, head: w.head, detached: w.detached, isMain: w.isMain, status: toGitStatusView(w.status), mergedClean: w.mergedClean, managed: w.managed, landed: w.landed, cleanupReason: w.cleanupReason };
}

export function toProjectView(r: Project): ProjectView {
  return {
    id: r.id,
    path: r.path,
    name: r.name,
    defaultBranch: r.defaultBranch,
    githubSlug: r.githubSlug,
    remotes: [...r.remotes],
    git: r.git,
    worktrees: r.worktrees.map(toWorktreeView),
  };
}

export function toProjectEventView(ev: ProjectEvent): ProjectEventView | null {
  const e = ev.event;
  switch (e.case) {
    case "snapshot":
      return { kind: "snapshot", projects: e.value.projects.map(toProjectView) };
    case "projectUpdated":
      return { kind: "projectUpdated", project: toProjectView(e.value) };
    case "projectRemovedId":
      return { kind: "projectRemoved", id: e.value };
    case "worktreeUpdated":
      return { kind: "worktreeUpdated", worktree: toWorktreeView(e.value) };
    case "worktreeRemoved":
      return { kind: "worktreeRemoved", projectId: e.value.projectId, path: e.value.path };
    case "worktreeDetailUpdated":
      return { kind: "worktreeDetailUpdated", projectId: e.value.projectId, path: e.value.path };
    default:
      return null;
  }
}

export async function listProjects(conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<ProjectView[]> {
  const c = await conn.client(ProjectService);
  const res = await c.list({}, { signal });
  return res.projects.map(toProjectView);
}

export interface RefsView {
  /** Local branches, then remote-tracking refs ("origin/main"), each sorted. */
  refs: string[];
  /** The default branch as a base: "<default branch>", or "origin/<default branch>" when only origin's copy exists. The daemon decides which copy at creation (projects.base_from_origin: origin's unless the local branch is ahead). */
  defaultRef: string;
  /** Branch short names, local and origin's merged by name, newest commit first (the composer's pickers). */
  branches: string[];
  /** The default branch's short name; "" when unknown. */
  defaultBranch: string;
}

/**
 * Refs a new worktree can be based on (ProjectService.ListRefs). A daemon older than the
 * RPC fails with OutdatedDaemonError.
 */
export async function listRefs(projectId: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<RefsView> {
  const c = await conn.client(ProjectService);
  try {
    const res = await c.listRefs({ projectId }, { signal });
    return { refs: [...res.refs], defaultRef: res.defaultRef, branches: [...res.branches], defaultBranch: res.defaultBranch };
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}
