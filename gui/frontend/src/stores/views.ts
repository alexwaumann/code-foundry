/**
 * Window-level views that are not selections: the settings page (replaces the content
 * area) and the help overlay. Top-level pages that are selections (ui.ts `viewNames`,
 * the Pull Requests page) are routed to `select`. Opened by view.settings / view.help (their chords are
 * presented locally, see keys/bindings.ts) or by a UiIntent.ShowView from the daemon.
 */
import { create } from "zustand";
import { togglePanelCommand } from "./panel";
import { useUiStore, viewNames } from "./ui";

interface ViewsState {
  settingsOpen: boolean;
  helpOpen: boolean;
}

export const useViewsStore = create<ViewsState>()(() => ({ settingsOpen: false, helpOpen: false }));

/** Shows a named view (UiIntent.ShowView.name). Returns false for an unknown name. */
export function showView(name: string): boolean {
  switch (name) {
    case "settings":
      useViewsStore.setState({ settingsOpen: true, helpOpen: false });
      return true;
    case "help":
      useViewsStore.setState({ helpOpen: true });
      return true;
    case "panel.toggle":
      // view.panel.toggle: an action on the current selection's side panel, not a page.
      togglePanelCommand();
      return true;
    default:
      // Top-level pages (the Pull Requests page) are selections. Closing settings here
      // too covers re-selecting the page that is already selected.
      if (!viewNames.includes(name)) return false;
      useViewsStore.setState({ settingsOpen: false, helpOpen: false });
      useUiStore.getState().select({ kind: "view", name });
      return true;
  }
}

export function closeSettings(): void {
  useViewsStore.setState({ settingsOpen: false });
  // Back to what was selected; its terminal takes focus again.
  useUiStore.setState((s) => ({ terminalFocusSeq: s.terminalFocusSeq + 1 }));
}

export function toggleHelp(): void {
  useViewsStore.setState((s) => ({ helpOpen: !s.helpOpen }));
}

export function setHelpOpen(open: boolean): void {
  useViewsStore.setState({ helpOpen: open });
}

/** Selecting something in the sidebar leaves the settings page. */
export function startViewSync(): () => void {
  return useUiStore.subscribe((s, prev) => {
    if (s.selection !== prev.selection && useViewsStore.getState().settingsOpen) useViewsStore.setState({ settingsOpen: false });
  });
}
