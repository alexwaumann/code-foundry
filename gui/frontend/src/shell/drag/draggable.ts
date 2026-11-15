/**
 * The pane grid's draggables (dnd-kit): any tab, active or not, a whole pane by the empty
 * part of its strip, and a sidebar row's thread. A press on a tab is the tab's (dnd-kit lets the innermost draggable take
 * a pointer down), so the strip's own drag starts only from its free space.
 * See docs/notes/shell-14-drag.md.
 */
import { useMemo } from "react";
import { useDraggable, type DraggableSyntheticListeners } from "@dnd-kit/core";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { usePaneDragged, useTabDragged, useThreadDragged } from "./state";
import type { DragSource } from "./targets";

export interface ShellDraggable {
  setNodeRef: (el: HTMLElement | null) => void;
  listeners: DraggableSyntheticListeners;
  /** The drag instructions' id, for aria-describedby. */
  describedBy: string | undefined;
  dragging: boolean;
}

export function useTabDrag(tabId: string, paneId: string): ShellDraggable {
  const data = useMemo<DragSource>(() => ({ kind: "tab", tab: tabId, pane: paneId }), [tabId, paneId]);
  const { setNodeRef, listeners, attributes } = useDraggable({
    id: `tab:${tabId}`,
    data,
  });
  return {
    setNodeRef,
    listeners,
    describedBy: attributes["aria-describedby"],
    dragging: useTabDragged(tabId),
  };
}

export function usePaneDrag(paneId: string): ShellDraggable {
  const data = useMemo<DragSource>(() => ({ kind: "pane", pane: paneId }), [paneId]);
  const { setNodeRef, listeners, attributes } = useDraggable({
    id: `pane:${paneId}`,
    data,
  });
  return {
    setNodeRef,
    listeners,
    describedBy: attributes["aria-describedby"],
    dragging: usePaneDragged(paneId),
  };
}

/**
 * A sidebar row's thread, in any section (docs/notes/shell-16-sidebar.md): into the grid when it
 * lives in the current space (an archived one with no tab open lives in none, so it drops in any),
 * onto a space tab whatever its space (ShellDnd and shell/drag/threadSource.ts decide). No drag
 * while the row's name is being edited: a press in the field selects text.
 */
export function useThreadDrag(threadId: string): ShellDraggable {
  const archived = useThreadsStore((s) => (s.byId[threadId]?.archivedAtMs ?? null) !== null);
  const renaming = useUiStore((s) => s.renamingThreadId === threadId);
  const data = useMemo<DragSource>(() => (archived ? { kind: "thread", thread: threadId, archived } : { kind: "thread", thread: threadId }), [threadId, archived]);
  const { setNodeRef, listeners, attributes } = useDraggable({
    id: `thread:${threadId}`,
    data,
    disabled: renaming,
  });
  return {
    setNodeRef,
    listeners,
    describedBy: attributes["aria-describedby"],
    dragging: useThreadDragged(threadId),
  };
}

/** A draggable's data as a drag source, or null for anything else. */
export function sourceOf(data: unknown): DragSource | null {
  if (typeof data !== "object" || data === null) return null;
  const d = data as Partial<DragSource> & { tab?: unknown; pane?: unknown };
  if (d.kind === "tab" && typeof d.tab === "string" && typeof d.pane === "string") return { kind: "tab", tab: d.tab, pane: d.pane };
  if (d.kind === "pane" && typeof d.pane === "string") return { kind: "pane", pane: d.pane };
  const t = data as { kind?: unknown; thread?: unknown; archived?: unknown };
  if (t.kind === "thread" && typeof t.thread === "string") return t.archived === true ? { kind: "thread", thread: t.thread, archived: true } : { kind: "thread", thread: t.thread };
  return null;
}
