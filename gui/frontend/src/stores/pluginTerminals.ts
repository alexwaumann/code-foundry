/**
 * Plugins' own terminals in the bottom panel (docs/notes/plugins-6-thread-terminal.md). A
 * plugin terminal (lib/termlabel isPluginLabels) belongs to no thread or worktree, so no
 * bottom panel shows it by itself: "Open in bottom panel" on its terminal node adds it to
 * the current selection's strip (TerminalsData.shownIn) and activates it. Its tab's ×
 * only takes it off the strip; the plugin closes the terminal. One Attach per terminal
 * view: while the terminal is the active tab of the bottom panel on screen, its node shows
 * a note instead of a second xterm (two would fight over the PTY's size).
 */
import { toast } from "sonner";
import { isPluginLabels } from "@/lib/termlabel";
import { activeTabOf, bottomKeyOf, bottomTabIds, bottomVisible, openOn, requestBottomFocus, updateBottom, useBottomStore } from "./bottomPanel";
import { keyOf, usePanelStore } from "./panel";
import { useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";

/**
 * Shows a plugin's terminal as a tab of the current selection's bottom panel, opens the
 * panel on it and focuses it. False (and a toast) when the selection has no bottom panel.
 */
export function showPluginTerminal(id: string): boolean {
  const key = bottomKeyOf(useUiStore.getState().selection);
  if (key === null) {
    toast.error("Select a thread to open the terminal in its bottom panel");
    return false;
  }
  useTerminalsStore.setState((s) => (s.shownIn?.[id] === key ? s : { shownIn: { ...s.shownIn, [id]: key } }));
  updateBottom(key, (e) => openOn(e, id));
  requestBottomFocus();
  return true;
}

/** Takes a plugin terminal's tab off the strip it was opened in; false for any other terminal. */
export function hidePluginTerminalTab(id: string): boolean {
  const t = useTerminalsStore.getState().byId[id];
  if (!t || !isPluginLabels(t.labels)) return false;
  useTerminalsStore.setState((s) => {
    if (!s.shownIn || !(id in s.shownIn)) return s;
    const { [id]: _gone, ...shownIn } = s.shownIn;
    return { shownIn };
  });
  return true;
}

/** Whether a terminal is the active tab of the bottom panel on screen now (it holds the terminal's view). */
export function useInVisibleBottom(id: string): boolean {
  const key = useUiStore((s) => bottomKeyOf(s.selection));
  const open = useBottomStore((s) => (key === null ? false : (s.byKey[key]?.open ?? false)));
  const remembered = useBottomStore((s) => (key === null ? undefined : s.byKey[key]?.activeTerminalId));
  const sideExpanded = usePanelStore((s) => {
    const k = keyOf(useUiStore.getState().selection);
    return k !== null && (s.byKey[k]?.open ?? false) && (s.byKey[k]?.expanded ?? false);
  });
  const active = useTerminalsStore((s) => (key === null ? null : activeTabOf(remembered === undefined ? { open: true } : { open: true, activeTerminalId: remembered }, bottomTabIds(s, key))));
  return bottomVisible(key, open, sideExpanded) && active === id;
}
