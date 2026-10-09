/**
 * Window-level views that are not selections: the settings page (replaces the content
 * area) and the help overlay. Top-level pages that are selections (ui.ts `viewNames`,
 * the Pull Requests page) are routed to `select`. Opened by view.settings / view.help (their chords are
 * presented locally, see keys/bindings.ts) or by a UiIntent.ShowView from the daemon.
 */
import { create } from "zustand";
import { getPanel, togglePanel } from "./panel";
import { useUiStore, viewNames, type FocusRegion } from "./ui";

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

/**
 * view.panel.toggle for the current selection. A no-op while the settings page is up: it
 * hides the panel, so a toggle there would flip state the user cannot see.
 *
 * Focus: toggling on focuses the panel. Hiding the panel while it has focus hands focus
 * to the content pane (its terminal, or the page's focus root). With the palette open
 * (the command was picked there), focus is the palette's, so the palette's return target
 * is what moves: to the panel when it opens, off it when it hides.
 */
export function togglePanelCommand(): boolean {
  if (useViewsStore.getState().settingsOpen) return getPanel().open;
  const ui = useUiStore.getState();
  const inPalette = ui.palette.open;
  const from: FocusRegion = inPalette ? ui.palette.returnTo : ui.focus;
  const open = togglePanel("current", undefined, { focus: !inPalette });
  if (inPalette) {
    const returnTo: FocusRegion = open ? "panel" : from === "panel" ? "content" : from;
    useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo } }));
  } else if (!open && from === "panel") {
    ui.focusContent();
  }
  return open;
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
