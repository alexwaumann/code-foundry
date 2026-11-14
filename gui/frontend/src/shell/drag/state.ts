/**
 * The drag in progress in the pane grid (window-only, never stored): what is dragged, where it
 * would land, and what the drag layer draws for it. components/shell/ShellDnd.tsx writes it;
 * the dragged tab and pane read their own slice of it to dim. See docs/notes/shell-14-drag.md.
 */
import { create } from "zustand";
import type { Rect } from "@/shell/geometry/types";
import type { DragSource, DropTarget } from "./targets";

export interface ShellDragState {
  source: DragSource | null;
  target: DropTarget | null;
  /** The pointer in viewport px (the ghost follows it). */
  client: { x: number; y: number } | null;
  /** The grid's top left in the viewport, in layout px: where `preview` and `bar` start. */
  origin: { x: number; y: number };
  /** The rectangle the drop will take, in the grid's layout px; null for a strip. */
  preview: Rect | null;
  /** A strip target's insertion bar, in the grid's layout px. */
  bar: { x: number; y: number; h: number } | null;
  /** The space whose tab in the top bar is under the pointer, when a drop there moves the source; "" otherwise (`target` is then null). */
  space: string;
}

const IDLE: ShellDragState = {
  source: null,
  target: null,
  client: null,
  origin: { x: 0, y: 0 },
  preview: null,
  bar: null,
  space: "",
};

export const useShellDragStore = create<ShellDragState>()(() => IDLE);

export function resetShellDrag(): void {
  useShellDragStore.setState(IDLE, true);
}

/** Whether this tab is the one being dragged. */
export function useTabDragged(tabId: string): boolean {
  return useShellDragStore((s) => s.source?.kind === "tab" && s.source.tab === tabId);
}

/** Whether this pane is being dragged whole. */
export function usePaneDragged(paneId: string): boolean {
  return useShellDragStore((s) => s.source?.kind === "pane" && s.source.pane === paneId);
}

/** Whether a drag is over this space's tab in the top bar, ready to move there. */
export function useSpaceDropTarget(spaceId: string): boolean {
  return useShellDragStore((s) => s.space !== "" && s.space === spaceId);
}

/** Whether this sidebar thread is being dragged (as its row, or as its open tab). */
export function useThreadDragged(threadId: string): boolean {
  return useShellDragStore((s) => s.source?.kind === "thread" && s.source.thread === threadId);
}
