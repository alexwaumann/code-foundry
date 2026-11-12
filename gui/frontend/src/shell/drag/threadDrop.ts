/**
 * Dropping a sidebar row's thread on the pane grid (docs/notes/shell-16-sidebar.md). No verb opens
 * a thread straight into a new pane, so a drop is `thread.open` into a pane (the target's, or for
 * the outer edge the focused one), then, for a place in a strip, an edge or the outer edge, a
 * `tab.move` of the tab it opened. A thread whose tab is open in the space drags as that tab
 * (ShellDnd), so this only ever opens one.
 */
import type { DropCommand } from "./drop";
import type { DropTarget } from "./targets";

export interface ThreadDropPlan {
  /** thread.open's arguments. */
  open: Record<string, string>;
  /**
   * The move of the tab it opened (`at`: its place in its strip), if the target is not the
   * pane's middle. Skipped when the thread took the place of the space's lone empty composer.
   */
  then: ((tab: string, at: number) => DropCommand) | null;
}

export function threadDropPlan(thread: string, target: DropTarget): ThreadDropPlan {
  const open = (pane: string) => ({ id: thread, focus: "true", ...(pane ? { pane } : {}) });
  switch (target.kind) {
    case "pane":
      return { open: open(target.pane), then: null };
    case "strip":
      // The target's index counts the strip before the tab opened at `at`; tab.move's counts it in
      // (and a reorder past its own place counts one less, internal/layout MoveTab).
      return { open: open(target.pane), then: (tab, at) => ({ name: "tab.move", args: { tab, pane: target.pane, index: String(target.index < at ? target.index : target.index + 1) } }) };
    case "edge":
      return { open: open(target.pane), then: (tab) => ({ name: "tab.move", args: { tab, split: target.pane, edge: target.edge } }) };
    case "outer":
      return { open: open(""), then: (tab) => ({ name: "tab.move", args: { tab, outer: target.edge } }) };
  }
}
