/**
 * Collapsing a pane on demand (docs/notes/shell-model.md, "Collapsing a pane";
 * docs/notes/shell-25d-collapse.md). pane.collapse is the command: cmd+shift+m (its keybinding)
 * toggles the focused pane, the strip's button collapses its pane, a collapsed pane's rail opens
 * it again. The choice lives in the daemon's layout; the window draws a collapsed pane as a rail
 * (shell/geometry/rails.ts). After either, the keyboard follows the focus: into the pane that took
 * it when one is collapsed, into the pane opened.
 */
import { useLayoutStore, type LayoutState, type TreeNode } from "@/stores/layout";
import { requestPaneFocus } from "@/stores/shellView";
import { afterRev, runLayoutCommand } from "./commands";

type Layout = Pick<LayoutState, "panes">;

/** Whether `paneId` is the only pane of its space that is not collapsed: it cannot be collapsed. */
export function isLastOpen(s: Layout, paneId: string): boolean {
  const pane = s.panes[paneId];
  if (!pane) return false;
  return !Object.values(s.panes).some((p) => p.id !== paneId && p.spaceId === pane.spaceId && !p.collapsed);
}

/** Why a pane's collapse is unavailable; "" when it can be collapsed. */
export function whyNoCollapse(s: Layout, paneId: string): string {
  return isLastOpen(s, paneId) ? "The last open pane of a space cannot be collapsed" : "";
}

/** The pane's place: in a column it folds to a strip ("col"), anywhere else to a rail ("row"). */
export function foldAxisOf(tree: TreeNode | null | undefined, paneId: string): "row" | "col" {
  const walk = (n: TreeNode, dir: "row" | "col"): "row" | "col" | null => {
    if (n.t === "pane") return n.id === paneId ? dir : null;
    for (const k of n.kids) {
      const hit = walk(k, n.dir);
      if (hit) return hit;
    }
    return null;
  };
  return (tree && walk(tree, "row")) || "row";
}

/** The current space's focused pane; "" with none. */
function focusedPane(): string {
  const s = useLayoutStore.getState();
  return s.spaces[s.currentSpaceId]?.focus ?? "";
}

/** Runs pane.collapse for a pane and moves the keyboard to the pane that has the focus after. */
async function run(paneId: string, collapse: boolean): Promise<void> {
  const res = await runLayoutCommand("pane.collapse", { pane: paneId, [collapse ? "on" : "off"]: "true" });
  if (!res) return;
  await afterRev(res.rev);
  const pane = focusedPane();
  if (pane) requestPaneFocus(pane);
}

/** Collapses a pane to a rail (the strip's button). Nothing for the last open pane of its space. */
export function collapsePane(paneId: string): Promise<void> {
  if (isLastOpen(useLayoutStore.getState(), paneId)) return Promise.resolve();
  return run(paneId, true);
}

/** Opens a collapsed pane again, with the focus (the rail's expand button). */
export function openPane(paneId: string): Promise<void> {
  return run(paneId, false);
}

/**
 * cmd+shift+m in the window: the focused pane collapses, or opens when it is collapsed. The last
 * open pane runs it too, so the daemon's refusal says why (a toast).
 */
export function toggleCollapseFocused(): Promise<void> {
  const pane = focusedPane();
  if (!pane) return Promise.resolve();
  return run(pane, !useLayoutStore.getState().panes[pane]?.collapsed);
}
