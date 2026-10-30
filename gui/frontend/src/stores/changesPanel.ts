/**
 * Opening a worktree's Changes tab (surfaces/changes.ts): the thread info card's Changes
 * row and its per-project rows (into the thread's panel), and the Projects page's project
 * and worktree rows (into the page's panel). Shows the panel without taking focus.
 */
import { CHANGES_TITLE, changesTab } from "@/surfaces/changesTarget";
import { openSurface, togglePanel, type PanelTarget } from "./panel";
import { findWorktree, useProjectsStore, type ProjectsData } from "./projects";

/**
 * A Changes tab's title: "Changes" for the thread's own checkout, else "Changes · web"
 * (and off the main worktree its branch too, "Changes · web · cf/demo"), so tabs opened
 * side by side stay apart.
 */
export function changesTabTitle(projects: ProjectsData, projectId: string, path: string): string {
  const name = projects.byId[projectId]?.name ?? projectId;
  const wt = findWorktree(projects, projectId, path);
  return !wt || wt.isMain || !wt.branch ? `${CHANGES_TITLE} · ${name}` : `${CHANGES_TITLE} · ${name} · ${wt.branch}`;
}

/**
 * Opens (or activates) the worktree's Changes tab in a panel and shows the panel, without
 * focus. `own`: the thread's cwd checkout, titled plain "Changes". False with nothing selected.
 */
export function openChangesTab(target: PanelTarget, projectId: string, path: string, own = false): boolean {
  const title = own ? CHANGES_TITLE : changesTabTitle(useProjectsStore.getState(), projectId, path);
  if (!openSurface(target, changesTab(projectId, path, title))) return false;
  togglePanel(target, true, { focus: false });
  return true;
}
