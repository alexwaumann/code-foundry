/**
 * The worktree surface's targets: which worktree a thread runs in (the surface's default
 * tab and availability) and a worktree's tab. Pure: callers feed it the stores' current
 * state. (The workspace surface that shared this file is gone since workspaces v2; a
 * thread's other checkouts are the Worktree tab's Also in list.)
 */
import { deriveContext } from "@/stores/context";
import { makeTab, type Tab } from "@/stores/panel";
import type { ProjectsData } from "@/stores/projects";
import type { ThreadsData } from "@/stores/threads";
import type { Selection } from "@/stores/ui";

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
