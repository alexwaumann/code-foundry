/**
 * What a screen reader hears while a tab or pane is dragged (dnd-kit's live region): what was
 * picked up, each new target, and what the drop did. Panes are named by their active tab.
 * See docs/notes/shell-14-drag.md.
 */
import type { DragSource, DropTarget } from "./targets";

/** The names the texts need: a tab's title, and a pane's (its active tab's title) with its tab count. */
export interface DragNames {
  tab: (id: string) => string;
  pane: (id: string) => string;
  tabCount: (pane: string) => number;
  /** A sidebar thread's name. */
  thread: (id: string) => string;
}

const EDGE_SIDE = {
  left: "left",
  right: "right",
  top: "top",
  bottom: "bottom",
} as const;

export function sourceText(source: DragSource, names: DragNames): string {
  if (source.kind === "tab") return `Tab ${names.tab(source.tab)}`;
  if (source.kind === "thread") return `Thread ${names.thread(source.thread)}`;
  const n = names.tabCount(source.pane);
  return `The pane of ${names.pane(source.pane)}${n > 1 ? ` (${String(n)} tabs)` : ""}`;
}

/** Where the drop would land, as a phrase ("position 2 of 3 in the pane of Diff"). */
export function targetText(source: DragSource, target: DropTarget, names: DragNames): string {
  switch (target.kind) {
    case "strip": {
      const own = source.kind === "tab" && source.pane === target.pane;
      const count = names.tabCount(target.pane) + (own ? 0 : 1);
      const at = own ? Math.min(target.index + 1, count) : target.index + 1;
      return `position ${String(at)} of ${String(count)} in the pane of ${names.pane(target.pane)}`;
    }
    case "pane":
      return `the pane of ${names.pane(target.pane)}`;
    case "edge":
      return `the ${EDGE_SIDE[target.edge]} edge of the pane of ${names.pane(target.pane)}`;
    case "outer":
      return `the ${EDGE_SIDE[target.edge]} edge of the whole pane area`;
  }
}

export function pickedUpText(source: DragSource, names: DragNames): string {
  return `Picked up ${lower(sourceText(source, names))}. Move it over a strip or an edge and release to drop it there, or press Escape to cancel.`;
}

export function overText(source: DragSource, target: DropTarget | null, names: DragNames): string {
  const what = sourceText(source, names);
  return target ? `${what} is over ${targetText(source, target, names)}.` : `${what} is over no place to drop.`;
}

export function droppedText(source: DragSource, target: DropTarget | null, names: DragNames): string {
  const what = sourceText(source, names);
  if (!target) return source.kind === "thread" ? `${what} was not opened.` : `${what} was put back.`;
  return `${what} was dropped on ${targetText(source, target, names)}.`;
}

export function cancelledText(source: DragSource, names: DragNames): string {
  return `Moving ${lower(sourceText(source, names))} was cancelled.`;
}

function lower(s: string): string {
  if (s.startsWith("Thread ")) return `thread ${s.slice(7)}`;
  return s.startsWith("The ") ? `the ${s.slice(4)}` : s.startsWith("Tab ") ? `tab ${s.slice(4)}` : s;
}

/** The instructions a draggable's aria-describedby reads. */
export const DRAG_INSTRUCTIONS =
  "To move this tab, drag it to another place in a strip, onto another pane, or onto an edge of a pane or of the whole pane area to split it off. Escape cancels a drag. A whole pane drags by the empty part of its strip.";
