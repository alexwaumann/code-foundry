/**
 * Opening files and diffs as side panel tabs (surfaces/files.ts, surfaces/diff.ts). GUI
 * state only: no daemon command. The Changes tab's rows open a Diff tab; the Diff tab's
 * Open file opens a File tab; path chips open File tabs through openFileInPanel too.
 */
import { diffTab, fileTab, type DiffTarget, type FileTarget } from "@/surfaces/fileTarget";
import { allTabs, getPanel, openSurface, usePanelStore, type PanelTarget, type Tab } from "./panel";

/**
 * Opens (or activates) a file's tab in a panel ("current": the window's selection) and
 * shows the panel; an open tab of the same file moves to the new line. A tab that is its
 * thread's page (view.panel.page) stays one when the file opens again another way (a
 * path chip), so its bridge keeps working. False with no panel.
 */
export function openFileInPanel(target: PanelTarget, file: FileTarget): boolean {
  let page = file.page;
  if (!page) {
    const tab = fileTab(file);
    const old = allTabs(getPanel(target)).find((t) => t.id === tab.id);
    if (old?.params.page === "1") page = { title: old.params.title ?? "" };
  }
  return openSurface(target, fileTab(page ? { ...file, page } : file));
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
