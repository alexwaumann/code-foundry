/**
 * Opening Ember's Board beside the chat (surfaces/ember.ts): the header's Board button and a
 * task link's click end here.
 */
import { EMBER_ENABLED, focusEmberTask } from "./ember";
import { emberBoardTab, EMBER_KIND, selectionIsEmber } from "@/surfaces/emberTarget";
import { openTab, tabPlace, targetOf, useTabPlace, type TabPlace } from "@/shell/host";
import { useSettingsStore } from "./settings";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";
import { useViewsStore } from "./views";

/** Whether an open panel shows the board: it is the active tab of one of its groups. */
function showsBoard(p: TabPlace): boolean {
  return p.shown && p.groups.some((g) => g.active?.kind === EMBER_KIND);
}

function emberPanelKey(): string | null {
  const sel = useUiStore.getState().selection;
  const enabled = useSettingsStore.getState().snapshot?.values[EMBER_ENABLED] === "true";
  return selectionIsEmber(sel, useThreadsStore.getState(), enabled) ? targetOf(sel) : null;
}

/** Opens (or activates) the Board tab in the Ember chat's panel; with a task, scrolls the board to it. False when the chat is not shown. */
export function openEmberBoard(taskId?: string): boolean {
  const key = emberPanelKey();
  if (key === null || !openTab(key, emberBoardTab())) return false;
  if (taskId) focusEmberTask(taskId);
  return true;
}

/**
 * The header's Board button: opens the board. While a tab shows it there is nothing to hide (the
 * classic side panel's hide went with it); Ember's chat in the shell is PR 24's.
 */
export function toggleEmberBoard(): boolean {
  const key = emberPanelKey();
  if (key === null) return false;
  if (showsBoard(tabPlace(key))) return true;
  return openTab(key, emberBoardTab());
}

/** Whether the Ember chat's panel shows the board now (the header's Board button is pressed). */
export function useEmberBoardShown(panelKey: string | null): boolean {
  return useTabPlace(panelKey || null, showsBoard);
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
