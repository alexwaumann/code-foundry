/**
 * The sidebar's multi-selection of thread rows (docs/notes/sidebar-bulk-select.md): window-local
 * UI state, never stored or sent. The rules are lib/sidebarSelection.ts; the expanded list's
 * ThreadListbox writes the shown order (pruning what left) and routes cmd- and shift-clicks here;
 * a row reads only whether it is selected; the bulk menu and a drag read the selection in order.
 */
import { useEffect } from "react";
import { create } from "zustand";
import { EMPTY_SELECTION, inOrder, pruneTo, rangeTo, toggleRow, type Selection } from "@/lib/sidebarSelection";

interface SidebarSelectionState extends Selection {
  /** Every thread row the expanded list shows, in display order. */
  order: readonly string[];
  /** The open thread's row (the sidebar's highlighted one): a shift-click's anchor while nothing is selected. */
  open: string | null;
}

export const useSidebarSelectionStore = create<SidebarSelectionState>()(() => ({ ...EMPTY_SELECTION, order: [], open: null }));

function put(next: Selection): void {
  useSidebarSelectionStore.setState({ ids: next.ids, anchor: next.anchor, base: next.base });
}

/** Cmd-click on a thread row. */
export function toggleSidebarRow(id: string): void {
  put(toggleRow(useSidebarSelectionStore.getState(), id));
}

/** Shift-click on a thread row. */
export function rangeSidebarRows(id: string): void {
  const s = useSidebarSelectionStore.getState();
  put(rangeTo(s, id, s.order, s.open));
}

/** Drops the selection (a plain click, Escape, an action done, a drag of another row). */
export function clearSidebarSelection(): void {
  const s = useSidebarSelectionStore.getState();
  if (s.ids.length === 0 && s.anchor === null && s.base === null) return;
  put(EMPTY_SELECTION);
}

/** The rows the list shows now, and the open thread's: a selected thread that left the list leaves the selection. */
export function setSidebarOrder(order: readonly string[], open: string | null): void {
  const s = useSidebarSelectionStore.getState();
  const next = pruneTo(s, order);
  useSidebarSelectionStore.setState(next === s ? { order, open } : { order, open, ids: next.ids, anchor: next.anchor, base: next.base });
}

/** The selected threads in display order. */
export function selectedSidebarThreads(): string[] {
  const s = useSidebarSelectionStore.getState();
  return inOrder(s, s.order);
}

/** Whether this thread's row is in the selection. */
export function useRowMultiSelected(id: string): boolean {
  return useSidebarSelectionStore((s) => s.ids.includes(id));
}

/** How many threads are selected. */
export function useSidebarSelectionSize(): number {
  return useSidebarSelectionStore((s) => s.ids.length);
}

/**
 * Escape anywhere drops the selection while there is one, unless something else took the key
 * (a dialog, a menu, an editor: they handle it first or prevent its default) or the keyboard is
 * in a field. The list's own Escape is ThreadListbox's.
 */
export function useEscapeClearsSidebarSelection(enabled: boolean): void {
  const any = useSidebarSelectionStore((s) => s.ids.length > 0);
  useEffect(() => {
    if (!enabled || !any) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      const t = e.target;
      if (t instanceof HTMLElement && t !== document.body && (t.isContentEditable || t.closest("input, textarea, select, [role=dialog], [role=menu]"))) return;
      clearSidebarSelection();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
    };
  }, [enabled, any]);
}
