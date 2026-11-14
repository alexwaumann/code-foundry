/**
 * Opening files and diffs as tabs (surfaces/files.ts, surfaces/diff.ts) through the host seam
 * (shell/host.ts): the layout places them. The Diff tab's Open file opens a File tab; path chips open
 * File tabs through openFileInPanel too.
 */
import { DEFAULT_BASE, DEFAULT_HEAD, DIFF_TITLE, diffTab, type DiffTarget } from "@/surfaces/diffTarget";
import { fileOfTab, fileTab, type FileTarget } from "@/surfaces/fileTarget";
import { isUnplaced } from "@/lib/threadSetup";
import { findTab, openTab, tabPlace, targetOf, threadOfTarget, type Tab, type TabTarget } from "@/shell/host";
import { useProjectsStore } from "./projects";
import { useThreadsStore } from "./threads";
import { HOME, useUiStore } from "./ui";

/**
 * Opens (or activates) a file's tab in a panel ("current": the window's selection) and
 * shows the panel; an open tab of the same file moves to the new line. A tab that is its
 * thread's page (view.panel.page) stays one when the file opens again another way (a
 * path chip), so its bridge keeps working, and a thread's open request to edit it stays
 * until it is saved or dismissed; a new request replaces it. `behind` leaves the tab's group
 * showing what it shows; `focus: false` (a thread's call) leaves the user's focus where it is.
 * A project's file opened on a thread with no checkout yet is held (FileTarget.heldFor): it is
 * that project's own. False with no panel.
 */
export function openFileInPanel(target: TabTarget, file: FileTarget, opts: { behind?: string; focus?: boolean } = {}): boolean {
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
 * under home) as a tab for what the window shows, whatever that is: a File tab reads
 * by path, so any panel can hold it. A selection with no panel of its own (`none`, which
 * draws the home composer) goes to the home composer, whose panel it is. False when no panel
 * took it.
 */
export function openLooseFile(dir: string, path: string): boolean {
  const ui = useUiStore.getState();
  if (targetOf(ui.selection) === null) ui.select(HOME);
  return openFileInPanel("current", { project: "", base: dir, path });
}

/** Opens (or activates) a checkout's Diff tab in a panel; an open one takes the new sources and file. `focus: false`: a thread's call. */
export function openDiffInPanel(target: TabTarget, diff: DiffTarget, title?: string, opts: { focus?: boolean } = {}): boolean {
  return openTab(target, diffTab(diff, title), opts);
}

/**
 * Opens (or activates) a checkout's Diff tab, keeping what an open one compares and shows,
 * and shows it with the focus: the thread info card's Changes rows and the Projects page's
 * checkout menus. `own`: the thread's cwd checkout, whose title names no project.
 * False with nothing selected.
 */
export function openCheckoutDiff(target: TabTarget, project: string, worktree: string, own = false): boolean {
  // Named at once, not when it first reads: a thread's checkouts often share a branch, and two plain "Diff" tabs tell nothing apart.
  const title = own ? DIFF_TITLE : `${DIFF_TITLE} · ${useProjectsStore.getState().byId[project]?.name ?? project}`;
  const fresh = diffTab({ project, worktree, base: DEFAULT_BASE, head: DEFAULT_HEAD, file: "", oldPath: "", own }, title);
  const open = findTab(target, fresh.id);
  return openTab(target, open ?? fresh);
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
