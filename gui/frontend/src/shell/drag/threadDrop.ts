/**
 * Dropping a sidebar row's thread on the pane grid (docs/notes/shell-16-sidebar.md): one
 * `thread.open` with the place, so the drop cannot stop halfway (docs/notes/shell-review-fixes-daemon.md).
 * The middle of a pane opens it in that pane, a place in a strip at that index, a pane's edge in
 * a new pane there (`--split`, `--edge`), and the grid's outer edge in a new pane on that edge
 * (`--outer`). A thread whose tab is open in the space drags as that tab (ShellDnd), so this only
 * ever opens one.
 */
import type { DropTarget } from "./targets";

/** thread.open's arguments for a drop of thread on target. */
export function threadDropArgs(thread: string, target: DropTarget): Record<string, string> {
  const open = { id: thread, focus: "true" };
  switch (target.kind) {
    case "pane":
      return { ...open, pane: target.pane };
    case "strip":
      // The target's index counts the strip without the new tab, as thread.open's does.
      return { ...open, pane: target.pane, index: String(target.index) };
    case "edge":
      return { ...open, split: target.pane, edge: target.edge };
    case "outer":
      return { ...open, outer: target.edge };
  }
}
