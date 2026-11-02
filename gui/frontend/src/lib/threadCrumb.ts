/**
 * The thread header's crumb, in front of its title (docs/notes/thread-header-crumb.md):
 * where the thread runs, then its parent when it has one. Pure, over the stores' data;
 * components/thread/ThreadParts.tsx renders it.
 */
import type { ThreadView } from "@/api/threads";
import { isWithin } from "./path";
import { isNoProject, NO_PROJECT, threadRowModel, type ProjectLookup, type WorkspaceLookup } from "./threadRow";

/** The place segment's icon: one project (its kind icon), a named workspace's layers, an unnamed set's folders, home. */
export type CrumbIcon = "folder" | "layers" | "folders" | "house";

export interface CrumbParent {
  id: string;
  /** Its current name (its id while unnamed); a removed creator's name at creation. */
  name: string;
  /** In the thread list (a click opens it); a removed creator is plain text. */
  exists: boolean;
}

/**
 * The page the place segment opens on a click: view.projects' args, a workspace's page
 * or a project's (docs/notes/thread-crumb-links.md).
 */
export type CrumbLink = { workspace: string } | { project: string };

export interface ThreadCrumb {
  icon: CrumbIcon;
  /** "web", "platform", "api +8", "No project". */
  label: string;
  /** What a click on the place opens; null (plain text) for no project or a removed one. */
  link: CrumbLink | null;
  /** The thread whose agent created it, else the thread it was forked from; null for neither. */
  parent: CrumbParent | null;
}

/** What the crumb reads of a thread. */
export type CrumbThread = Pick<ThreadView, "projectId" | "workspaceId" | "worktreePath" | "pendingWorktreePath" | "projectIds" | "createdBy" | "createdByName" | "parentId">;

/** The threads the parent is looked up in (stores/threads ThreadsData qualifies). */
export interface ParentLookup {
  byId: Readonly<Record<string, Pick<ThreadView, "name"> | undefined>>;
}

/**
 * The thread's parent: its creator (an agent's thread) under its current name, or the
 * name it had at creation once removed (docs/notes/lineage-by-id.md); else the thread it
 * was forked from while that still exists (a fork records no name).
 */
export function crumbParent(t: Pick<CrumbThread, "createdBy" | "createdByName" | "parentId">, threads: ParentLookup): CrumbParent | null {
  if (t.createdBy) {
    const c = threads.byId[t.createdBy];
    return c ? { id: t.createdBy, name: c.name || t.createdBy, exists: true } : { id: t.createdBy, name: t.createdByName || t.createdBy, exists: false };
  }
  const p = t.parentId ? threads.byId[t.parentId] : undefined;
  return p ? { id: t.parentId, name: p.name || t.parentId, exists: true } : null;
}

/**
 * Where the thread runs, as the crumb names it: no project (house, "No project"); a
 * workspace the store knows (layers, its name); several projects in no known workspace
 * (folders, the cwd's project and "+N" for the rest); one project (folder, its name).
 */
export function crumbPlace(t: Omit<CrumbThread, "createdBy" | "createdByName" | "parentId">, projects: ProjectLookup, workspaces: WorkspaceLookup): Pick<ThreadCrumb, "icon" | "label"> {
  if (isNoProject(t, projects)) return { icon: "house", label: NO_PROJECT };
  const ws = t.workspaceId ? workspaces.byId[t.workspaceId] : undefined;
  if (ws) return { icon: "layers", label: ws.name || t.workspaceId };
  const here = threadRowModel({ ...t, projectCount: 1 }, projects, workspaces).project;
  const n = t.projectIds.length;
  if (n > 1) return { icon: "folders", label: `${projects.byId[t.projectId]?.name ?? (t.projectId || here)} +${String(n - 1)}` };
  return { icon: "folder", label: here };
}

/**
 * The page the place opens: a workspace the store knows, its page (a workspace's thread,
 * whatever its primary); else the primary project's page while that project is known
 * (one project, or an unnamed set: the cwd's project, the one its label names), or for an
 * older row with no project id the project whose checkout holds its cwd. Null for no
 * project, and for a project (or set) whose project was removed: plain text.
 */
export function crumbLink(t: Omit<CrumbThread, "createdBy" | "createdByName" | "parentId" | "projectIds">, projects: ProjectLookup, workspaces: WorkspaceLookup): CrumbLink | null {
  if (isNoProject(t, projects)) return null;
  if (t.workspaceId && workspaces.byId[t.workspaceId]) return { workspace: t.workspaceId };
  if (t.projectId) return projects.byId[t.projectId] ? { project: t.projectId } : null;
  for (const [id, p] of Object.entries(projects.byId)) if (p?.worktrees.some((w) => isWithin(t.worktreePath, w.path))) return { project: id };
  return null;
}

/** The whole crumb: crumbPlace and crumbLink, then crumbParent. */
export function threadCrumb(t: CrumbThread, projects: ProjectLookup, workspaces: WorkspaceLookup, threads: ParentLookup): ThreadCrumb {
  return { ...crumbPlace(t, projects, workspaces), link: crumbLink(t, projects, workspaces), parent: crumbParent(t, threads) };
}
