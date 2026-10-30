/** The Changes surface's tab: which worktree it shows. Pure. */
import { makeTab, type Tab } from "@/stores/panel";

export const CHANGES_KIND = "changes";
export const CHANGES_TITLE = "Changes";

/** A worktree: the project it belongs to and its path. */
export interface ChangesTarget {
  projectId: string;
  path: string;
}

/** A worktree's Changes tab: params { project, path }, one tab per worktree, titled by the caller. */
export function changesTab(projectId: string, path: string, title: string = CHANGES_TITLE): Tab {
  return makeTab(CHANGES_KIND, title, { project: projectId, path });
}

/** The worktree a Changes tab names; null when its params are not one. */
export function changesOfTab(tab: Pick<Tab, "params">): ChangesTarget | null {
  const projectId = tab.params.project ?? "";
  const path = tab.params.path ?? "";
  return projectId && path ? { projectId, path } : null;
}
