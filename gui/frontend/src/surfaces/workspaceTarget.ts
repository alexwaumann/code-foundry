/**
 * The workspace and worktree surfaces' targets: which workspace a selection's thread
 * belongs to (availability), which worktree a thread runs in (the worktree surface's
 * default tab), the tabs (the workspace itself, and a worktree), and the thread a
 * Projects page workspace row opens it for. The member rows' current/queued marker is
 * lib/projects.ts threadAt. Pure: callers feed it the stores' current state.
 */
import type { ThreadView } from "@/api/threads";
import { deriveContext } from "@/stores/context";
import { makeTab, type Tab } from "@/stores/panel";
import type { ProjectsData } from "@/stores/projects";
import type { ThreadsData } from "@/stores/threads";
import type { Selection } from "@/stores/ui";

export const WORKSPACE_KIND = "workspace";
export const WORKTREE_KIND = "worktree";

export interface SelectionStores {
  repos: ProjectsData;
  threads: ThreadsData;
}

/** A workspace thread: the thread and the workspace that owns it. */
export interface WorkspaceThread {
  threadId: string;
  workspaceId: string;
}

/**
 * The selection's workspace thread: a thread owned by a workspace (deriveContext's
 * activeThreadId + activeWorkspaceId, which is what view.panel.workspace's availability
 * sees). Null for a project thread, a page, or a workspace composer (it has no thread yet).
 */
export function selectionWorkspaceThread(sel: Selection, s: SelectionStores): WorkspaceThread | null {
  if (sel.kind !== "thread") return null;
  const ctx = deriveContext(sel, s.repos, s.threads);
  return ctx.activeThreadId && ctx.activeWorkspaceId ? { threadId: ctx.activeThreadId, workspaceId: ctx.activeWorkspaceId } : null;
}

/** A worktree: the project it belongs to and its path. */
export interface WorktreeTarget {
  projectId: string;
  path: string;
}

/**
 * The worktree the selection's thread runs in, placed in a registered worktree
 * (deriveContext's activeProjectId + activeWorktreePath). Null for a worktree or repo page (the overview is the content
 * already), a top-level page, a composer, or a thread whose cwd is in no worktree.
 */
export function selectionWorktree(sel: Selection, s: SelectionStores): WorktreeTarget | null {
  if (sel.kind !== "thread") return null;
  const ctx = deriveContext(sel, s.repos, s.threads);
  return ctx.activeProjectId && ctx.activeWorktreePath ? { projectId: ctx.activeProjectId, path: ctx.activeWorktreePath } : null;
}

/** The workspace surface's tab: params { workspace }, titled with the workspace's name. */
export function workspaceTab(workspaceId: string, name: string): Tab {
  return makeTab(WORKSPACE_KIND, name || "Workspace", { workspace: workspaceId });
}

/** The workspace a workspace tab names; null when its params are not one. */
export function workspaceOfTab(tab: Pick<Tab, "params">): string | null {
  return tab.params.workspace || null;
}

/**
 * A worktree's tab: params { repo, path }. Titled by the caller: a workspace member with
 * the project alone (stores/workspacePanel.ts), any other worktree with the project and,
 * off the main worktree, its branch (stores/worktreePanel.ts worktreeTabTitle).
 */
export function worktreeTab(projectId: string, path: string, title: string): Tab {
  return makeTab(WORKTREE_KIND, title, { repo: projectId, path });
}

/** A workspace member's worktree tab (worktreeTab, titled with the project's name). */
export const memberTab = worktreeTab;

/** The worktree a worktree tab names; null when its params are not one. */
export function worktreeOfTab(tab: Pick<Tab, "params">): WorktreeTarget | null {
  const projectId = tab.params.repo ?? "";
  const path = tab.params.path ?? "";
  return projectId && path ? { projectId, path } : null;
}

/** worktreeOfTab, under the workspace surface's name for its member tabs. */
export const memberOfTab = worktreeOfTab;

/**
 * The thread a workspace row on the Projects page opens the surface for: the workspace's
 * thread that was active most recently (else the newest), whether or not Claude runs for
 * it; archived threads are passed over. Null when the workspace has no such thread: the
 * row then keeps step 4's actions only.
 */
export function workspaceThread(threads: ThreadsData, workspaceId: string): string | null {
  let best: ThreadView | null = null;
  for (const id of threads.order) {
    const s = threads.byId[id];
    if (s?.workspaceId !== workspaceId || s.archivedAtMs !== null) continue;
    const at = s.lastActivityAtMs ?? s.createdAtMs ?? 0;
    const bestAt = best ? (best.lastActivityAtMs ?? best.createdAtMs ?? 0) : -1;
    if (at > bestAt) best = s;
  }
  return best?.id ?? null;
}
