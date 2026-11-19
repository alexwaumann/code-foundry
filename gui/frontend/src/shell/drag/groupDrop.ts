/**
 * Dragging the sidebar's selection (docs/notes/sidebar-bulk-select.md), and the Archived and
 * Snoozed headers as drop targets for any row drag. Pure: ShellDnd reads the layout and the
 * threads and runs what these say.
 *
 * A group is two or more threads in display order. Each moves as a single row would
 * (threadSource.ts): a thread whose tab is open in the current space as that tab (`tab.move`),
 * any other opened (`thread.open`).
 *
 *   - Into the grid, the first lands where the drop says (a place in a strip, a pane's middle at
 *     the end of its strip, a new pane on a pane's edge or the outer edge: the split is made once,
 *     by that first one), then each next one right after the one before, in that one's pane
 *     (`after`, resolved when it runs, from the layout the step before committed). So a drop is
 *     one command per thread and never one split per thread. The grid takes a group only when it
 *     takes every one of them.
 *   - On a space tab, one `thread.space.move --ids` with those not living there already, when
 *     each of the others could go there.
 *   - On the Archived header, `thread.archive --ids` with those not archived; on the Snoozed
 *     header, `thread.snooze --ids --save` with those not snoozed or saved (and not being set
 *     up, which the daemon refuses). A drop that would act on none is no target.
 */
import { isSnoozed } from "@/lib/snooze";
import { spaceDropCommands, type SpaceCommand } from "@/shell/spaces";
import { spaceOfThread, type LayoutState } from "@/stores/layout";
import type { DragSource, DropTarget } from "./targets";
import { openThreadTab, threadDropsInGrid } from "./threadSource";

type Layout = Pick<LayoutState, "panes" | "tabs" | "threads" | "defaultSpaceId">;

/** One step of a drop: a layout verb, whose `pane` and `index` are filled when it runs from where `after`'s tab is then. */
export interface DropStep extends SpaceCommand {
  /** The thread whose tab this one lands right after (the step before's). */
  after?: string;
}

/** The headers a thread drag can drop on. */
export type HeaderSection = "archived" | "snoozed";

/** What the header rules read of a thread (stores/threads' entry). */
export interface HeaderThreadFacts {
  archivedAtMs: number | null;
  snoozedUntilMs: number | null;
  savedAtMs?: number | null;
  setup?: { phase: string } | null;
}

/** Which of the dragged threads a drop on the header acts on, in order; [] when it is no target. */
export function headerDropIds(section: HeaderSection, ids: readonly string[], byId: Readonly<Record<string, HeaderThreadFacts | undefined>>): string[] {
  return ids.filter((id) => {
    const t = byId[id];
    if (!t) return false;
    if (section === "archived") return t.archivedAtMs === null;
    return !isSnoozed(t) && t.setup?.phase !== "running";
  });
}

/**
 * What a sidebar row's drag carries: the selection, in display order (`ordered`), when the grabbed
 * row is in it and two or more are selected; else the row alone, and the selection is dropped
 * (`keep` false).
 */
export function rowDragGroup(thread: string, picked: readonly string[], ordered: readonly string[]): { group: string[]; keep: boolean } {
  if (picked.length >= 2 && picked.includes(thread)) return { group: [...ordered], keep: true };
  return { group: [], keep: false };
}

/** A group's thread as its drag sees it, with the archived flag the single row's source carries. */
function threadSource(thread: string, archived: boolean): Extract<DragSource, { kind: "thread" }> {
  return archived ? { kind: "thread", thread, archived } : { kind: "thread", thread };
}

/** Whether the current space's grid takes every thread of the group (threadSource.ts's rule for each). */
export function groupDropsInGrid(ids: readonly string[], s: Layout, spaceId: string, archived: (id: string) => boolean): boolean {
  return ids.length > 0 && ids.every((id) => threadDropsInGrid(threadSource(id, archived(id)), s, spaceId));
}

/** The steps a group dropped on `target` in the current space runs (see the file's comment). */
export function groupGridSteps(ids: readonly string[], target: DropTarget, s: Layout, spaceId: string): DropStep[] {
  const steps: DropStep[] = [];
  let prev = "";
  for (const id of ids) {
    const tab = openThreadTab(s, id);
    const here = tab && s.panes[tab.paneId]?.spaceId === spaceId ? tab : undefined;
    const base: Record<string, string> = here ? { tab: here.id } : { id, focus: "true" };
    const name = here ? "tab.move" : "thread.open";
    if (prev) {
      steps.push({ name, args: base, after: prev });
    } else {
      steps.push({ name, args: { ...base, ...firstPlace(target, s) } });
    }
    prev = id;
  }
  return steps;
}

/** Where the group's first thread lands: the drop's place, a pane's middle meaning the end of its strip. */
function firstPlace(target: DropTarget, s: Layout): Record<string, string> {
  switch (target.kind) {
    case "pane":
      return { pane: target.pane, index: String(s.panes[target.pane]?.tabIds.length ?? 0) };
    case "strip":
      return { pane: target.pane, index: String(target.index) };
    case "edge":
      return { split: target.pane, edge: target.edge };
    case "outer":
      return { outer: target.edge };
  }
}

/** A step ready to run: `after`'s tab's pane and the place right after it; null when that tab is not open in the space (the step before failed). */
export function resolveStep(step: DropStep, s: Pick<LayoutState, "panes" | "tabs">, spaceId: string): SpaceCommand | null {
  if (!step.after) return { name: step.name, args: step.args };
  const tab = openThreadTab(s, step.after);
  const pane = tab ? s.panes[tab.paneId] : undefined;
  if (!tab || !pane || pane.spaceId !== spaceId) return null;
  return { name: step.name, args: { ...step.args, pane: pane.id, index: String(pane.tabIds.indexOf(tab.id) + 1) } };
}

/**
 * The one command a group dropped on a space tab runs: `thread.space.move --ids` with the threads
 * not living there yet. Null (no target) when none would move, or when one of them could not go
 * (an archived thread with no tab open lives in no space: spaceDropCommands).
 */
export function groupSpaceCommands(ids: readonly string[], space: string, s: Layout, archived: (id: string) => boolean): SpaceCommand[] | null {
  const moving = ids.filter((id) => spaceOfThread(s, id) !== space || (archived(id) && !openThreadTab(s, id)));
  if (moving.length === 0) return null;
  if (moving.some((id) => !spaceDropCommands(threadSource(id, archived(id)), space, s))) return null;
  return [{ name: "thread.space.move", args: { ids: moving.join(","), space } }];
}
