/**
 * Spaces in the top bar (docs/notes/shell-model.md, "Structure"): pure functions the top bar, its
 * dialogs and the drag layer read. A space tab shows a small glyph drawn from the space's real pane
 * layout, its name, and the count of the user's own threads in it that need them. A tab or a pane
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

/**
 * How many of `attention` (the user's own threads that need them: stores/threads.ts attentionIds,
 * which leaves out archived, snoozed and thread-started threads) live in each space.
 */
export function spaceAttentionCounts(attention: readonly string[], s: Pick<LayoutState, "threads" | "defaultSpaceId">): Record<string, number> {
  const out: Record<string, number> = {};
  for (const id of attention) {
    const sp = spaceOfThread(s, id);
    out[sp] = (out[sp] ?? 0) + 1;
  }
  return out;
}

/** A layout verb and its arguments. */
export interface SpaceCommand {
  name: string;
  args: Record<string, string>;
}

/** The space a tab or a pane is in; "" when it is gone. */
function spaceOfSource(source: DragSource, s: Pick<LayoutState, "panes" | "tabs">): string {
  const pane = source.kind === "tab" ? s.tabs[source.tab]?.paneId : source.pane;
  return s.panes[pane ?? ""]?.spaceId ?? "";
}

/**
 * What dropping a tab or a pane on a space tab runs, in order (shell-model.md, "Linked surfaces"):
 * a thread's tab moves the thread, which takes its linked tabs in its space along
 * (`thread.space.move`); any other tab moves by itself (`tab.move --space`): a linked one waits
 * there, dormant. A pane moves whole (`pane.move --space`); the daemon moves no thread tab that
 * way, so each thread in it moves first with its linked tabs, and the pane follows with what is
 * left, when anything is. Null when the drop does nothing: its own space, or a source that went.
 */
export function spaceDropCommands(source: DragSource, space: string, s: Pick<LayoutState, "panes" | "tabs">): SpaceCommand[] | null {
  const from = spaceOfSource(source, s);
  if (!from || from === space) return null;
  if (source.kind === "tab") {
    const tab = s.tabs[source.tab];
    if (!tab) return null;
    if (tab.kind === "thread") return [{ name: "thread.space.move", args: { id: tab.thread, space } }];
    return [{ name: "tab.move", args: { tab: tab.id, space } }];
  }
  const pane = s.panes[source.pane];
  if (!pane) return null;
  const tabs = pane.tabIds.flatMap((id) => (s.tabs[id] ? [s.tabs[id]] : []));
  const threads = [...new Set(tabs.filter((t) => t.kind === "thread").map((t) => t.thread))];
  const left = tabs.filter((t) => t.kind !== "thread" && !(t.thread && threads.includes(t.thread)));
  const out: SpaceCommand[] = threads.map((id) => ({ name: "thread.space.move", args: { id, space } }));
  if (left.length > 0) out.push({ name: "pane.move", args: { pane: pane.id, space } });
  return out;
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
