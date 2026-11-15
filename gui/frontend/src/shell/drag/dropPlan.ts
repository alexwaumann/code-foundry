/**
 * What a drag's end runs (components/shell/ShellDnd.tsx), as data: on a space tab, what
 * shell/spaces.ts spaceDropCommands says; in the grid, a sidebar row's thread opens there in one
 * `thread.open` with the place (threadDrop.ts), and a tab or a pane moves in one `tab.move` or
 * `pane.move` (drop.ts). Null when the drop does nothing.
 */
import { spaceDropCommands, type SpaceCommand } from "@/shell/spaces";
import type { LayoutState } from "@/stores/layout";
import { dropCommand } from "./drop";
import type { DragSource, DropTarget } from "./targets";
import { threadDropArgs } from "./threadDrop";

export interface DropPlan {
  /** The space whose tab took the drop; "" for a drop in the grid. */
  space: string;
  /** Run in order, each after the last one's commit (shell/spaceActions.ts runSpaceDrop). */
  commands: SpaceCommand[];
}

/**
 * The commands a drop of `source` runs: on the space tab `space` when it is set, else on
 * `target` in the grid. `s` is the layout as it is at the drop: a tab or pane closed mid-drag
 * moves nothing.
 */
export function dropPlan(source: DragSource, target: DropTarget | null, space: string, s: Pick<LayoutState, "panes" | "tabs" | "threads" | "defaultSpaceId">): DropPlan | null {
  if (space) {
    const commands = spaceDropCommands(source, space, s);
    return commands ? { space, commands } : null;
  }
  if (!target) return null;
  if (source.kind === "thread") return { space: "", commands: [{ name: "thread.open", args: threadDropArgs(source.thread, target) }] };
  if (source.kind === "tab" ? !s.tabs[source.tab] : !s.panes[source.pane]) return null;
  const cmd = dropCommand(source, target, s.panes[source.pane]?.tabIds ?? []);
  return cmd ? { space: "", commands: [cmd] } : null;
}
