/**
 * Opening files and diffs as side panel tabs (surfaces/files.ts, surfaces/diff.ts). GUI
 * state only: no daemon command. The Diff tab's Open file opens a File tab; path chips open
 * File tabs through openFileInPanel too.
 */
import { DEFAULT_BASE, DEFAULT_HEAD, DIFF_TITLE, diffTab, type DiffTarget } from "@/surfaces/diffTarget";
import { fileOfTab, fileTab, type FileTarget } from "@/surfaces/fileTarget";
import { isUnplaced } from "@/lib/threadSetup";
import { expandTabs, findTab, openTab, showTabs, tabPlace, targetOf, threadOfTarget, type Tab, type TabTarget } from "@/shell/host";
import { useProjectsStore } from "./projects";
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
export function openFileInPanel(target: TabTarget, file: FileTarget, opts: { behind?: boolean } = {}): boolean {
  const id = fileTab(file).id;
  const old = findTab(target, id);
  const was = old ? fileOfTab(old) : null;
  const thread = threadOfTarget(target);
  const held = was?.heldFor ?? (file.project && isUnplaced(useThreadsStore.getState().byId[thread]) ? thread : "");
  const keeps = {
    ...(was?.page && !file.page ? { page: was.page } : {}),
    ...(was?.ask && !file.ask ? { ask: was.ask, edit: true } : {}),
    ...(held ? { heldFor: held } : {}),
  };
  return openTab(target, fileTab({ ...file, ...keeps }), opts);
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
  if (targetOf(ui.selection) === null) ui.select(HOME);
  if (!openFileInPanel("current", { project: "", base: dir, path })) return false;
  const now = useUiStore.getState();
  if (panelMax(now.windowWidth, visibleSidebarWidth(now)) < PANEL_MIN) expandTabs("current", { focus: false });
  return true;
}

/** Opens (or activates) a checkout's Diff tab in a panel; an open one takes the new sources and file. */
export function openDiffInPanel(target: TabTarget, diff: DiffTarget, title?: string): boolean {
  return openTab(target, diffTab(diff, title));
}

/**
 * Opens (or activates) a checkout's Diff tab, keeping what an open one compares and shows,
 * and shows the panel without focus: the thread info card's Changes rows and the Projects
 * page's checkout menus. `own`: the thread's cwd checkout, whose title names no project.
 * False with nothing selected.
 */
export function openCheckoutDiff(target: TabTarget, project: string, worktree: string, own = false): boolean {
  // Named at once, not when it first reads: a thread's checkouts often share a branch, and two plain "Diff" tabs tell nothing apart.
  const title = own ? DIFF_TITLE : `${DIFF_TITLE} · ${useProjectsStore.getState().byId[project]?.name ?? project}`;
  const fresh = diffTab({ project, worktree, base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "", oldPath: "", own }, title);
  const open = findTab(target, fresh.id);
  if (!openTab(target, open ?? fresh)) return false;
  showTabs(target, true, { focus: false });
  return true;
}

/**
 * A panel's last tab of a kind (strip order, the first group's strip then the second's),
 * which the surface's letter brings back; null without one.
 */
export function lastTabOf(kind: string, panelKey: string): Tab | null {
  const { tabs } = tabPlace(panelKey);
  for (let i = tabs.length - 1; i >= 0; i--) {
    const t = tabs[i];
    if (t?.kind === kind) return t;
  }
  return null;
}
