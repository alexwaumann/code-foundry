/**
 * Opening a worktree as a side panel tab (surfaces/worktree.ts), the only place a
 * worktree's overview shows: the Projects page's project and worktree rows (into the
 * page's own panel), the daemon's ui.focus.repo and the thread row menu's Show
 * worktree, and the selected thread's own worktree through T in the panel and
 * view.panel.worktree (worktreePanelCommand in stores/views.ts). Workspace member tabs
 * are stores/workspacePanel.ts openMemberTab.
 */
import { selectionWorktree, worktreeTab } from "@/surfaces/workspaceTarget";
import { keyOf, openSurface, togglePanel, type PanelTarget } from "./panel";
import { findWorktree, mainWorktreePath, useProjectsStore, type ProjectsData } from "./projects";
import { useThreadsStore } from "./threads";
import { useUiStore, type Selection } from "./ui";

/**
 * A worktree tab's title: the project's name, and off the main worktree its branch too
 * ("web · cf/demo"), so a project's worktrees opened side by side stay apart. A worktree
 * the store does not know (gone, or a project without git) gets the project alone.
 */
export function worktreeTabTitle(repos: ProjectsData, projectId: string, path: string): string {
  const name = repos.byId[projectId]?.name ?? projectId;
  const wt = findWorktree(repos, projectId, path);
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
 * Shows a worktree from anywhere (ui.focus.repo, the Add Project flows): the Projects
 * page with the worktree's tab in its panel. An empty path means the project's main
 * worktree. False for an unknown project.
 */
export function showWorktreeOnProjectsPage(projectId: string, path = ""): boolean {
  const repos = useProjectsStore.getState();
  const at = path || mainWorktreePath(repos, projectId);
  if (!repos.byId[projectId] || !at) return false;
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
 * Opens (or activates) the selection's own worktree tab in its panel when the selection
 * is a thread in a registered worktree. Returns that panel's key, or null
 * otherwise. It does not request focus.
 */
export function openWorktreeSurface(sel: Selection = useUiStore.getState().selection): string | null {
  const key = keyOf(sel);
  const w = selectionWorktree(sel, { repos: useProjectsStore.getState(), threads: useThreadsStore.getState() });
  if (key === null || w === null) return null;
  return openWorktreeTab(key, w.projectId, w.path) ? key : null;
}
