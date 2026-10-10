/**
 * The workspace and worktree surfaces' targets: which workspace a selection's thread
 * belongs to (availability), which worktree a thread runs in (the worktree surface's
 * default tab), the tabs (the workspace itself, and a worktree), and the thread a
 * Projects page workspace row opens it for. The member rows' current/queued marker is
 * lib/projects.ts threadAt. Pure: callers feed it the stores' current state.
 */
import type { SessionView } from "@/api/session";
import { deriveContext } from "@/stores/context";
import { makeTab, type Tab } from "@/stores/panel";
import type { ReposData } from "@/stores/repos";
import type { SessionsData } from "@/stores/sessions";
import type { TerminalsData } from "@/stores/terminals";
import type { Selection } from "@/stores/ui";

export const WORKSPACE_KIND = "workspace";
export const WORKTREE_KIND = "worktree";

export interface SelectionStores {
  repos: ReposData;
  sessions: SessionsData;
  terminals: TerminalsData;
}

/** A workspace thread: the thread and the workspace that owns it. */
export interface WorkspaceThread {
  sessionId: string;
  workspaceId: string;
}

/**
 * The selection's workspace thread: a session, or a thread's terminal, whose thread is
 * owned by a workspace (deriveContext's activeSessionId + activeWorkspaceId, which is what
 * view.panel.workspace's availability sees). Null for a project thread, a plain terminal,
 * a worktree, a page, or a workspace composer (it has no thread yet).
 */
export function selectionWorkspaceThread(sel: Selection, s: SelectionStores): WorkspaceThread | null {
  if (sel.kind !== "session" && sel.kind !== "terminal") return null;
  const ctx = deriveContext(sel, s.terminals, s.repos, s.sessions);
  return ctx.activeSessionId && ctx.activeWorkspaceId ? { sessionId: ctx.activeSessionId, workspaceId: ctx.activeWorkspaceId } : null;
}

/** A worktree: the project it belongs to and its path. */
export interface WorktreeTarget {
  repoId: string;
  path: string;
}

/**
 * The worktree the selection's thread runs in: a session, or a thread's terminal (or a
 * plain terminal), placed in a registered worktree (deriveContext's activeRepoId +
 * activeWorktreePath). Null for a worktree or repo page (the overview is the content
 * already), a top-level page, a composer, or a thread whose cwd is in no worktree.
 */
export function selectionWorktree(sel: Selection, s: SelectionStores): WorktreeTarget | null {
  if (sel.kind !== "session" && sel.kind !== "terminal") return null;
  const ctx = deriveContext(sel, s.terminals, s.repos, s.sessions);
  return ctx.activeRepoId && ctx.activeWorktreePath ? { repoId: ctx.activeRepoId, path: ctx.activeWorktreePath } : null;
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
export function worktreeTab(repoId: string, path: string, title: string): Tab {
  return makeTab(WORKTREE_KIND, title, { repo: repoId, path });
}

/** A workspace member's worktree tab (worktreeTab, titled with the project's name). */
export const memberTab = worktreeTab;

/** The worktree a worktree tab names; null when its params are not one. */
export function worktreeOfTab(tab: Pick<Tab, "params">): WorktreeTarget | null {
  const repoId = tab.params.repo ?? "";
  const path = tab.params.path ?? "";
  return repoId && path ? { repoId, path } : null;
}

/** worktreeOfTab, under the workspace surface's name for its member tabs. */
export const memberOfTab = worktreeOfTab;

/**
 * The thread a workspace row on the Projects page opens the surface for: the workspace's
 * connected thread (not disconnected) that was active most recently, else the newest.
 * Null when no thread of the workspace is live: the row then keeps step 4's actions only.
 */
export function liveWorkspaceThread(sessions: SessionsData, workspaceId: string): string | null {
  let best: SessionView | null = null;
  for (const id of sessions.order) {
    const s = sessions.byId[id];
    if (s?.workspaceId !== workspaceId || s.state === "disconnected") continue;
    const at = s.lastActivityAtMs ?? s.createdAtMs ?? 0;
    const bestAt = best ? (best.lastActivityAtMs ?? best.createdAtMs ?? 0) : -1;
    if (at > bestAt) best = s;
  }
  return best?.id ?? null;
}
