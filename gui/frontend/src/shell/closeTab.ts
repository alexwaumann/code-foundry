/**
 * Closing tabs as the user does (cmd+w, a tab's ×, a middle click, cmd+shift+w): a surface with
 * work that would be lost asks first (ShellSurface.beforeClose: a File tab with unsaved edits
 * offers Save, Discard and Keep editing), as the side panel did. A refusal closes nothing. A
 * thread closing its linked tabs (they are remembered and come back) asks nothing.
 * See docs/notes/shell-20-cutover.md.
 */
import { useLayoutStore, type TabEntry } from "@/stores/layout";
import { closeTabNow, runLayoutCommand, type LayoutCommandResult } from "./commands";

/** Asks each tab's surface in turn; false at the first that keeps its tab. */
export async function mayClose(tabs: readonly TabEntry[]): Promise<boolean> {
  // Loaded when asked: the keymap (keys/bindings.ts, which every store reaches) imports this file,
  // and the surface registry imports every surface's components.
  const { shellSurfaceOf } = await import("./surfaces/registry");
  for (const tab of tabs) {
    const ask = shellSurfaceOf(tab.kind).beforeClose;
    if (ask && !(await ask(tab))) return false;
  }
  return true;
}

/** tab.close, once its surface agreed; null when it did not, or the close failed. */
export async function closeTabAsked(tabId: string): Promise<LayoutCommandResult | null> {
  const tab = useLayoutStore.getState().tabs[tabId];
  if (tab && !(await mayClose([tab]))) return null;
  return closeTabNow(tabId);
}

/** pane.close, once every tab's surface agreed; null when one did not, or the close failed. */
export async function closePaneAsked(paneId: string): Promise<LayoutCommandResult | null> {
  const s = useLayoutStore.getState();
  const tabs = (s.panes[paneId]?.tabIds ?? []).flatMap((id) => s.tabs[id] ?? []);
  if (!(await mayClose(tabs))) return null;
  return runLayoutCommand("pane.close", { pane: paneId });
}
