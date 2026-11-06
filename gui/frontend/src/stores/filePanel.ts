/**
 * Opening files and diffs as side panel tabs (surfaces/files.ts, surfaces/diff.ts). GUI
 * state only: no daemon command. The Changes tab's rows open a Diff tab; the Diff tab's
 * Open file opens a File tab; path chips open File tabs through openFileInPanel too.
 */
import { diffTab, fileOfTab, fileTab, type DiffTarget, type FileTarget } from "@/surfaces/fileTarget";
import { isUnplaced } from "@/lib/threadSetup";
import { allTabs, expandPanel, getPanel, keyOf, openSurface, panelThreadId, usePanelStore, type PanelTarget, type Tab } from "./panel";
import { useThreadsStore } from "./threads";
import { HOME, PANEL_MIN, panelMax, useUiStore, visibleSidebarWidth } from "./ui";

/**
 * Opens (or activates) a file's tab in a panel ("current": the window's selection) and
 * shows the panel; an open tab of the same file moves to the new line. A tab that is its
 * thread's page (view.panel.page) stays one when the file opens again another way (a
 * path chip), so its bridge keeps working, and a thread's open request to edit it stays
 * until it is saved or dismissed; a new request replaces it. `behind` leaves the tab's group
 * showing what it shows. A project's file opened on a thread with no checkout yet is held
 * (FileTarget.heldFor): it is that project's own. False with no panel.
 */
export function openFileInPanel(target: PanelTarget, file: FileTarget, opts: { behind?: boolean } = {}): boolean {
  const id = fileTab(file).id;
  const old = allTabs(getPanel(target)).find((t) => t.id === id);
  const was = old ? fileOfTab(old) : null;
  const thread = panelThreadId(target);
  const held = was?.heldFor ?? (file.project && isUnplaced(useThreadsStore.getState().byId[thread]) ? thread : "");
  const keeps = {
    ...(was?.page && !file.page ? { page: was.page } : {}),
    ...(was?.ask && !file.ask ? { ask: was.ask, edit: true } : {}),
    ...(held ? { heldFor: held } : {}),
  };
  return openSurface(target, fileTab({ ...file, ...keeps }), opts);
}

/**
 * Opens a file that belongs to no project (a skill's SKILL.md: `path` in the folder `dir`,
 * under home) in the side panel of what the window shows, whatever that is: a File tab reads
 * by path, so any panel can hold it. A selection with no panel of its own (`none`, which
 * draws the home composer) goes to the home composer, whose panel it is. A window too narrow
 * to show a panel beside the content gets it expanded, or the tab would open out of sight.
 * False when no panel took it.
 */
export function openLooseFile(dir: string, path: string): boolean {
  const ui = useUiStore.getState();
  if (keyOf(ui.selection) === null) ui.select(HOME);
  if (!openFileInPanel("current", { project: "", base: dir, path })) return false;
  const now = useUiStore.getState();
  if (panelMax(now.windowWidth, visibleSidebarWidth(now)) < PANEL_MIN) expandPanel("current", true, { focus: false });
  return true;
}

/** Opens (or activates) a changed file's Diff tab in a panel; an open one takes the new scope. */
export function openDiffInPanel(target: PanelTarget, diff: DiffTarget): boolean {
  return openSurface(target, diffTab(diff));
}

/** A Changes row as the Diff tab opens it: the working tree when it has uncommitted changes, else the branch. */
export function diffOfChange(project: string, worktree: string, change: { path: string; oldPath: string; uncommitted: boolean }): DiffTarget {
  return { project, worktree, path: change.path, oldPath: change.oldPath, scope: change.uncommitted ? "working" : "branch" };
}

/**
 * A panel's last tab of a kind (strip order, the first group's strip then the second's),
 * which the surface's letter brings back; null without one.
 */
export function lastTabOf(kind: string, panelKey: string): Tab | null {
  const e = usePanelStore.getState().byKey[panelKey];
  const tabs = e ? allTabs(e) : [];
  for (let i = tabs.length - 1; i >= 0; i--) {
    const t = tabs[i];
    if (t?.kind === kind) return t;
  }
  return null;
}
