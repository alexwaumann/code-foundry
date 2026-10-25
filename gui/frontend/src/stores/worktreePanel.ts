/**
 * Opening a worktree as a side panel tab (surfaces/worktree.ts), the only place a
 * worktree's overview shows: the Projects page's project and worktree rows (into the
 * page's own panel), the daemon's ui.focus.project and the thread row menu's Show
 * worktree, and the selected thread's own worktree through T in the panel and
 * view.panel.worktree (worktreePanelCommand in stores/views.ts); a thread whose primary
 * is its workspace's folder gets the folder head instead (selectionTab). A thread's other
 * checkouts open from its tab's Also in list (stores/threadCheckouts.ts openAlsoIn).
 */
import { folderTab, selectionFolder, selectionWorktree, worktreeTab } from "@/surfaces/worktreeTarget";
import { keyOf, openSurface, togglePanel, type PanelTarget, type Tab } from "./panel";
import { findWorktree, mainWorktreePath, useProjectsStore, type ProjectsData } from "./projects";
import { useThreadsStore } from "./threads";
import { useUiStore, type Selection } from "./ui";
import { useWorkspacesStore } from "./workspaces";

/**
 * A worktree tab's title: the project's name, and off the main worktree its branch too
 * ("web · cf/demo"), so a project's worktrees opened side by side stay apart. A worktree
 * the store does not know (gone, or a project without git) gets the project alone.
 */
export function worktreeTabTitle(projects: ProjectsData, projectId: string, path: string): string {
  const name = projects.byId[projectId]?.name ?? projectId;
  const wt = findWorktree(projects, projectId, path);
  return !wt || wt.isMain || !wt.branch ? name : `${name} · ${wt.branch}`;
}

/** Opens (or activates) the worktree's tab in a panel and shows the panel. It does not request focus. */
export function openWorktreeTab(target: PanelTarget, projectId: string, path: string): boolean {
  return openSurface(target, worktreeTab(projectId, path, worktreeTabTitle(useProjectsStore.getState(), projectId, path)));
}

/**
 * The Projects page's Enter or double-click on a project (its main worktree) or worktree
 * row: the worktree's tab in the current selection's panel (the page's), shown but not
 * focused, so the list keeps the keyboard. False with nothing selected.
 */
export function showWorktreeInPanel(projectId: string, path: string): boolean {
  if (!openWorktreeTab("current", projectId, path)) return false;
  togglePanel("current", true, { focus: false });
  return true;
}

/**
 * Shows a worktree from anywhere (ui.focus.project, the Add Project flows): the Projects
 * page with the worktree's tab in its panel. An empty path means the project's main
 * worktree. False for an unknown project.
 */
export function showWorktreeOnProjectsPage(projectId: string, path = ""): boolean {
  const projects = useProjectsStore.getState();
  const at = path || mainWorktreePath(projects, projectId);
  if (!projects.byId[projectId] || !at) return false;
  useUiStore.getState().select({ kind: "view", name: "projects" });
  return showWorktreeInPanel(projectId, at);
}

/**
 * The thread row menu's Show worktree: selects the thread and opens its own worktree's
 * tab in its panel, which takes focus. False when the thread is in no registered worktree.
 */
export function showWorktreeInThread(threadId: string): boolean {
  const sel: Selection = { kind: "thread", id: threadId };
  useUiStore.getState().select(sel);
  const key = openWorktreeSurface(sel);
  if (key === null) return false;
  togglePanel(key, true, { focus: true });
  return true;
}

/**
 * The selection's own Worktree tab: its worktree's for a thread in a registered worktree,
 * the folder head for a thread in its workspace's folder (titled with the workspace);
 * null for anything else.
 */
export function selectionTab(sel: Selection): Tab | null {
  const projects = useProjectsStore.getState();
  const threads = useThreadsStore.getState();
  const w = selectionWorktree(sel, { projects, threads });
  if (w) return worktreeTab(w.projectId, w.path, worktreeTabTitle(projects, w.projectId, w.path));
  const workspaces = useWorkspacesStore.getState();
  const f = selectionFolder(sel, { threads, workspaces });
  return f ? folderTab(f.workspaceId, f.path, workspaces.byId[f.workspaceId]?.name ?? f.workspaceId) : null;
}

/**
 * Opens (or activates) the selection's own Worktree tab (selectionTab) in its panel.
 * Returns that panel's key, or null when the selection has none. It does not request
 * focus.
 */
export function openWorktreeSurface(sel: Selection = useUiStore.getState().selection): string | null {
  const key = keyOf(sel);
  const tab = selectionTab(sel);
  if (key === null || tab === null) return null;
  return openSurface(key, tab) ? key : null;
}
