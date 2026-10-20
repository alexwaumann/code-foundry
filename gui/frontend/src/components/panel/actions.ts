/** What the side panel's strips, bodies and keys share: closing a tab, hiding the panel, ids. */
import { allTabs, closePanelTab, getPanel, isSplit, togglePanel, type GroupIndex } from "@/stores/panel";
import { useUiStore } from "@/stores/ui";

/** Asks the panel's <aside> to take focus (SidePanel answers panelFocusSeq). */
export function refocusPanel(): void {
  useUiStore.setState((s) => ({ panelFocusSeq: s.panelFocusSeq + 1 }));
}

/**
 * Closing the panel's last tab hides it, unless appearance.panel_keep_open keeps it open
 * on the surface list. If it had focus, a hidden panel hands focus to the content pane (a
 * thread's prompt, or the page's focus root), and a kept one takes it back (the closed
 * tab's × had it), so keys keep working: cmd+w hides it, the letters open a surface. So
 * does a split that collapsed because a group lost its last tab: that group's strip is gone.
 */
export function closeTab(panelKey: string, id: string): void {
  const hadFocus = useUiStore.getState().focus === "panel";
  const wasSplit = isSplit(getPanel(panelKey));
  closePanelTab(panelKey, id);
  if (!hadFocus) return;
  const after = getPanel(panelKey);
  if (!after.open) useUiStore.getState().focusContent();
  else if (allTabs(after).length === 0 || (wasSplit && !isSplit(after))) refocusPanel();
}

/** Hides the panel (cmd+w with no tabs) and gives focus to the content pane. */
export function hidePanel(panelKey: string): void {
  togglePanel(panelKey, false);
  useUiStore.getState().focusContent();
}

/**
 * Whether a tab of a strip under `root` is being dragged. Escape then belongs to the
 * drag: dnd-kit cancels it from a `keydown` listener on the document, which a React
 * handler that stops the key (the panel's Escape while picking) would starve.
 */
export function liftedTab(root: Element): boolean {
  return root.querySelector("[data-dragging]") !== null;
}

/** A tab's `role="tab"` button id (tab ids are unique in a panel, across both groups). */
export function tabDomId(id: string): string {
  return `panel-tab-${encodeURIComponent(id)}`;
}

/** A group's `role="tabpanel"` id: the first group keeps the unsplit panel's. */
export function bodyDomId(group: GroupIndex): string {
  return group === 0 ? "side-panel-body" : "side-panel-body-1";
}
