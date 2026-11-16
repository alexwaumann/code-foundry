/**
 * The parts a thread's menu items (ThreadMenuItems.tsx) render with, for a Radix context
 * menu (the sidebar row) or a dropdown (the thread header's title), and the focus rule
 * both menus close with.
 */
import type { ComponentType, ReactNode } from "react";
import {
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import { useUiStore } from "@/stores/ui";

type Children = { children?: ReactNode };
type Tagged = Children & { "data-testid"?: string };

/**
 * The menu parts the items render with: a Radix context menu's (the sidebar row) or a
 * dropdown's (the thread header's title). Their props differ; the items need only these.
 */
export interface MenuKit {
  Item: ComponentType<Tagged & { onSelect: () => void; disabled?: boolean; variant?: "default" | "destructive"; [data: `data-${string}`]: string | undefined }>;
  Separator: ComponentType;
  /** An item's key, at its right end. */
  Shortcut: ComponentType<Children>;
  Label: ComponentType<Children & { className?: string }>;
  Sub: ComponentType<Children>;
  SubTrigger: ComponentType<Tagged>;
  SubContent: ComponentType<Tagged & { className?: string }>;
  /**
   * After an item that leaves the thread where it is (Pin, Snooze, Archive and their undo),
   * the keyboard goes to the thread's prompt, as the header's old buttons left it: the
   * title menu's. The sidebar row's menu hands it back to the list as before.
   */
  promptAfterInPlace: boolean;
  /**
   * The menu is the thread's sidebar row's own, so the row is on screen and shows what an
   * item did (the pin, the row leaving for Archived, the flag going): no success toast for
   * those (docs/notes/toast-success-rule.md). The header's menu has no such row in view (the
   * sidebar may be hidden), so they toast from there.
   */
  rowInView: boolean;
}

export const contextMenuKit: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Shortcut: ContextMenuShortcut,
  Label: ContextMenuLabel,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  promptAfterInPlace: false,
  rowInView: true,
};

export const dropdownMenuKit: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Shortcut: DropdownMenuShortcut,
  Label: DropdownMenuLabel,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  promptAfterInPlace: true,
  rowInView: false,
};

/**
 * A thread tab's context menu (components/thread/ThreadMenu.tsx): a context menu's parts, but no
 * sidebar row is known to be in view, so its items toast as the header's do.
 */
export const tabMenuKit: MenuKit = { ...contextMenuKit, rowInView: false };

/** The thread an in-place item just ran for from a promptAfterInPlace menu (markInPlace). */
let inPlace: string | null = null;
let lapse: ReturnType<typeof setTimeout> | undefined;

/** An in-place item ran for thread `id` from `kit`'s menu: on close, its prompt takes the keyboard. */
export function markInPlace(kit: MenuKit, id: string): void {
  if (!kit.promptAfterInPlace) return;
  inPlace = id;
  // A menu that never got to close (its pane went with an archive) leaves no stale mark;
  // a newer mark replaces the older one's timer, which must not clear it.
  clearTimeout(lapse);
  lapse = setTimeout(() => {
    inPlace = null;
  }, 1000);
}

/**
 * For a menu's onCloseAutoFocus: Rename puts an input in the sidebar row, New thread on
 * this branch focuses the composer's prompt, Move to project… opens the move picker (markMovePicking), and an in-place item of the title menu hands
 * the keyboard to the thread's prompt (focusPromptAfterMenu), so closing must not move
 * focus back to the menu's trigger. True when it should stay where the item put it.
 */
export function keepFocusAfterMenu(id: string): boolean {
  const ui = useUiStore.getState();
  return inPlace === id || ui.renamingThreadId === id || (ui.selection.kind === "compose" && ui.selection.likeThreadId === id) || movePicking === id;
}

/** The thread "Move to project…" just ran for: its picker opens, so the menu's close leaves focus alone. */
let movePicking: string | null = null;
let movePickingLapse: ReturnType<typeof setTimeout> | undefined;

/** "Move to project…" ran for thread `id`: the closing menu must not take focus back (keepFocusAfterMenu). */
export function markMovePicking(id: string): void {
  movePicking = id;
  clearTimeout(movePickingLapse);
  movePickingLapse = setTimeout(() => {
    movePicking = null;
  }, 1000);
}

/** After keepFocusAfterMenu: when an in-place item closed the menu, asks the selected thread's prompt for the keyboard. */
export function focusPromptAfterMenu(id: string): void {
  if (inPlace !== id) return;
  inPlace = null;
  const sel = useUiStore.getState().selection;
  if (sel.kind === "thread" && sel.id === id) useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
}

/** The thread whose tab menu's item moved the keyboard (into a tab it opened or focused). */
let tabMenuMoved = "";

/** An item of thread `id`'s tab menu put the keyboard in a tab. */
export function markTabMenuMoved(id: string): void {
  tabMenuMoved = id;
}

/**
 * ShellSurface.tabMenuKeepsFocus for a thread's tab: an item put the keyboard somewhere (a tab,
 * the rename field, the composer, the move picker), so the closing menu leaves it there.
 */
export function threadTabMenuKeepsFocus(tab: { thread: string }): boolean {
  const was = tabMenuMoved === tab.thread;
  tabMenuMoved = "";
  return was || keepFocusAfterMenu(tab.thread);
}
