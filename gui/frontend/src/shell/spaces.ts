/**
 * Spaces in the top bar (docs/notes/shell-model.md, "Structure"): pure functions the top bar, its
 * dialogs and the drag layer read. A space tab shows a small glyph drawn from the space's real pane
 * layout, its name, and the count of the user's own threads in it that need them (that count is
 * lib/shellSections.ts needsBySpace, the Needs you section's own membership). A tab or a pane
 * dropped on a space tab moves there as the daemon's verbs move it.
 * See docs/notes/shell-15-spaces.md.
 */
import { plainRects } from "@/shell/geometry/rects";
import type { GeoNode, Rect } from "@/shell/geometry/types";
import type { DragSource } from "@/shell/drag/targets";
import { spaceOfThread, type LayoutState } from "@/stores/layout";

/** The glyph's box in CSS px. */
export const GLYPH = { w: 16, h: 12 } as const;

/**
 * The layout is laid out plainly (proportions, the 12px gutter, no minimums) in an area this many
 * times the glyph, then scaled down: the gutter becomes a 1.5px gap, as the panes look at a glance.
 */
const GLYPH_SCALE = 8;

/** Rounds to a quarter pixel, so a glyph's numbers stay short and stable. */
const q = (n: number) => Math.round(n * 4) / 4;

/**
 * The glyph of a space: one rectangle per pane in the glyph's box (GLYPH), from the same plain
 * geometry the daemon places by (geometry/rects.ts plainRects). A space with no pane is one
 * rectangle, as one pane would be.
 */
export function spaceGlyph(root: GeoNode | null): Rect[] {
  if (!root) return [{ x: 0, y: 0, w: GLYPH.w, h: GLYPH.h }];
  const f = plainRects(root, GLYPH.w * GLYPH_SCALE, GLYPH.h * GLYPH_SCALE);
  return Object.values(f.rects).map((r) => ({ x: q(r.x / GLYPH_SCALE), y: q(r.y / GLYPH_SCALE), w: q(r.w / GLYPH_SCALE), h: q(r.h / GLYPH_SCALE) }));
}

/** A layout verb and its arguments. */
export interface SpaceCommand {
  name: string;
  args: Record<string, string>;
}

/** The space a tab, a pane or a sidebar thread is in; "" when the tab or pane is gone. */
function spaceOfSource(source: DragSource, s: Pick<LayoutState, "panes" | "tabs" | "threads" | "defaultSpaceId">): string {
  if (source.kind === "thread") return spaceOfThread(s, source.thread);
  const pane = source.kind === "tab" ? s.tabs[source.tab]?.paneId : source.pane;
  return s.panes[pane ?? ""]?.spaceId ?? "";
}

/**
 * What dropping a tab or a pane on a space tab runs, in order (shell-model.md, "Linked surfaces"):
 * a thread's tab moves the thread, which takes its linked tabs in its space along
 * (`thread.space.move`); any other tab moves by itself (`tab.move --space`): a linked one waits
 * there, dormant. A pane moves whole (`pane.move --space`), in one step: each thread whose tab it
 * holds moves with it and takes its other linked tabs along, so a drop never ends half moved.
 * A sidebar row's thread moves as its tab would, open or not
 * (docs/notes/shell-16-sidebar.md). Null when the drop does nothing: its own space, or a source
 * that went.
 */
export function spaceDropCommands(source: DragSource, space: string, s: Pick<LayoutState, "panes" | "tabs" | "threads" | "defaultSpaceId">): SpaceCommand[] | null {
  const from = spaceOfSource(source, s);
  if (!from || from === space) return null;
  if (source.kind === "thread") return [{ name: "thread.space.move", args: { id: source.thread, space } }];
  if (source.kind === "tab") {
    const tab = s.tabs[source.tab];
    if (!tab) return null;
    if (tab.kind === "thread") return [{ name: "thread.space.move", args: { id: tab.thread, space } }];
    return [{ name: "tab.move", args: { tab: tab.id, space } }];
  }
  const pane = s.panes[source.pane];
  if (!pane) return null;
  return [{ name: "pane.move", args: { pane: pane.id, space } }];
}

/** The two ways a space's threads go when it is removed. */
export type RemoveChoice = { kind: "move"; to: string } | { kind: "archive" };

/** space.remove's arguments for a choice (internal/command commands_space.go). */
export function removeSpaceArgs(space: string, choice: RemoveChoice): Record<string, string> {
  return choice.kind === "archive" ? { space, archive: "true" } : { space, to: choice.to };
}

/**
 * The space a removed space's threads move to by default: the one on its left, else on its right
 * (the daemon's own default). "" for the last space.
 */
export function defaultRemoveTarget(order: readonly string[], space: string): string {
  const i = order.indexOf(space);
  if (i < 0 || order.length < 2) return "";
  return (i > 0 ? order[i - 1] : order[1]) ?? "";
}

/** The threads space.remove moves or archives: the user's own (not archived) living in the space. */
export function threadsOfSpace(own: readonly string[], space: string, s: Pick<LayoutState, "threads" | "defaultSpaceId">): string[] {
  return own.filter((id) => spaceOfThread(s, id) === space);
}

/** The space ctrl+cmd+n switches to: the nth in the top bar (from 1); "" past the last. */
export function spaceAtIndex(order: readonly string[], n: number): string {
  return order[n - 1] ?? "";
}

/** A space tab dragged onto another's place takes that place (as a sortable list moves it): space.move's --index, from 1; null for no move. */
export function reorderIndex(order: readonly string[], id: string, overId: string): number | null {
  const from = order.indexOf(id);
  const to = order.indexOf(overId);
  if (from < 0 || to < 0 || from === to) return null;
  return to + 1;
}
