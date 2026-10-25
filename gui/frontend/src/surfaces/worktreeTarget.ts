/**
 * The worktree surface's targets: which worktree a thread runs in (the surface's default
 * tab and availability) and a worktree's tab. Pure: callers feed it the stores' current
 * state. A thread whose primary is its workspace's folder gets the same tab with a folder
 * head (selectionFolder, folderTab); a thread's other checkouts are the tab's Also in list.
 */
import { samePath, workspaceFolder } from "@/lib/workspaceCard";
import { deriveContext } from "@/stores/context";
import { makeTab, type Tab } from "@/stores/panel";
import type { ProjectsData } from "@/stores/projects";
import type { ThreadsData } from "@/stores/threads";
import type { Selection } from "@/stores/ui";
import type { WorkspacesData } from "@/stores/workspaces";

export const WORKTREE_KIND = "worktree";

export interface SelectionStores {
  projects: ProjectsData;
  threads: ThreadsData;
}

/** A worktree: the project it belongs to and its path. */
export interface WorktreeTarget {
  projectId: string;
  path: string;
}

/**
 * The worktree the selection's thread runs in, placed in a registered worktree
 * (deriveContext's activeProjectId + activeWorktreePath). Null for a top-level page, a
 * composer, or a thread whose cwd is in no worktree (a workspace's folder, home).
 */
export function selectionWorktree(sel: Selection, s: SelectionStores): WorktreeTarget | null {
  if (sel.kind !== "thread") return null;
  const ctx = deriveContext(sel, s.projects, s.threads);
  return ctx.activeProjectId && ctx.activeWorktreePath ? { projectId: ctx.activeProjectId, path: ctx.activeWorktreePath } : null;
}

/**
 * A worktree's tab: params { project, path }, titled by the caller (stores/worktreePanel.ts
 * worktreeTabTitle: the project and, off the main worktree, its branch). Each worktree is
 * its own tab.
 */
export function worktreeTab(projectId: string, path: string, title: string): Tab {
  return makeTab(WORKTREE_KIND, title, { project: projectId, path });
}

/** The worktree a worktree tab names; null when its params are not one. */
export function worktreeOfTab(tab: Pick<Tab, "params">): WorktreeTarget | null {
  const projectId = tab.params.project ?? "";
  const path = tab.params.path ?? "";
  return projectId && path ? { projectId, path } : null;
}

/**
 * A workspace's own folder as a Worktree tab's "folder head" (no git facts): where a
 * thread whose primary is the workspace runs (its root, else its managed dir).
 */
export interface FolderTarget {
  workspaceId: string;
  path: string;
}

/**
 * The workspace folder the selection's thread runs in: a thread with a workspace, no
 * primary project, and its cwd the workspace's folder. Null otherwise (a thread in a
 * worktree has selectionWorktree; a removed workspace has no folder to show).
 */
export function selectionFolder(sel: Selection, s: { threads: ThreadsData; workspaces: Pick<WorkspacesData, "byId"> }): FolderTarget | null {
  if (sel.kind !== "thread") return null;
  const t = s.threads.byId[sel.id];
  if (!t?.workspaceId || t.projectId) return null;
  const ws = s.workspaces.byId[t.workspaceId];
  return ws && samePath(t.worktreePath, workspaceFolder(ws)) ? { workspaceId: ws.id, path: t.worktreePath } : null;
}

/** A workspace folder's Worktree tab: params { workspace, path } (no project), titled with the workspace's name. */
export function folderTab(workspaceId: string, path: string, title: string): Tab {
  return makeTab(WORKTREE_KIND, title, { workspace: workspaceId, path });
}

/** The workspace folder a Worktree tab names; null for a worktree's tab or bad params. */
export function folderOfTab(tab: Pick<Tab, "params">): FolderTarget | null {
  const workspaceId = tab.params.workspace ?? "";
  const path = tab.params.path ?? "";
  return workspaceId && path && !tab.params.project ? { workspaceId, path } : null;
}
