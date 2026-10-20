/**
 * Opening Ember's Board in the chat's side panel (surfaces/ember.ts): the header's Board
 * button and a task link's click end here.
 */
import { EMBER_ENABLED, focusEmberTask } from "./ember";
import { emberBoardTab, EMBER_KIND, selectionIsEmber } from "@/surfaces/emberTarget";
import { getPanel, keyOf, openSurface, togglePanel, usePanelStore, type PanelEntry } from "./panel";
import { useSettingsStore } from "./settings";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";
import { useViewsStore } from "./views";

/** Whether an open panel shows the board: it is the active tab of one of its groups. */
function showsBoard(e: PanelEntry | undefined): boolean {
  return e?.open === true && e.groups.some((g) => g.tabs.find((t) => t.id === g.activeTabId)?.kind === EMBER_KIND);
}

function emberPanelKey(): string | null {
  const sel = useUiStore.getState().selection;
  const enabled = useSettingsStore.getState().snapshot?.values[EMBER_ENABLED] === "true";
  return selectionIsEmber(sel, useThreadsStore.getState(), enabled) ? keyOf(sel) : null;
}

/** Opens (or activates) the Board tab in the Ember chat's panel; with a task, scrolls the board to it. False when the chat is not shown. */
export function openEmberBoard(taskId?: string): boolean {
  const key = emberPanelKey();
  if (key === null || !openSurface(key, emberBoardTab())) return false;
  if (taskId) focusEmberTask(taskId);
  return true;
}

/** The header's Board button: hides the panel while it shows the board, else opens the board. */
export function toggleEmberBoard(): boolean {
  const key = emberPanelKey();
  if (key === null) return false;
  if (showsBoard(getPanel(key))) return !togglePanel(key, false, { focus: false });
  return openSurface(key, emberBoardTab());
}

/** Whether the Ember chat's panel shows the board now (the header's Board button is pressed). */
export function useEmberBoardShown(panelKey: string | null): boolean {
  return usePanelStore((s) => showsBoard(panelKey ? s.byKey[panelKey] : undefined));
}

/** The sidebar keyboard cursor's key for Ember's pinned row (stores/ui.ts cursorKey). */
export const EMBER_ROW_KEY = "ember";

/** Opens Ember's chat, as a thread row's click opens its thread. */
export function openEmber(threadId: string): void {
  useUiStore.getState().select({ kind: "thread", id: threadId }, { focusPrompt: true });
}

/** Opens the settings page on Ember's page. */
export function openEmberSettings(): void {
  useViewsStore.setState({ settingsOpen: true, settingsPage: "ember", usageOpen: false, themesOpen: false, helpOpen: false });
}
