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
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
  Item: ComponentType<Tagged & { onSelect: () => void; disabled?: boolean; "data-member"?: string; "data-preset"?: string }>;
  Separator: ComponentType;
  Label: ComponentType<Children>;
  Sub: ComponentType<Children>;
  SubTrigger: ComponentType<Tagged>;
  SubContent: ComponentType<Tagged>;
  /**
   * After an item that leaves the thread where it is (Pin, Snooze, Archive and their undo),
   * the keyboard goes to the thread's prompt, as the header's old buttons left it: the
   * title menu's. The sidebar row's menu hands it back to the list as before.
   */
  promptAfterInPlace: boolean;
}

export const contextMenuKit: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Label: ContextMenuLabel,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
  promptAfterInPlace: false,
};

export const dropdownMenuKit: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Label: DropdownMenuLabel,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
  promptAfterInPlace: true,
};

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
 * this branch focuses the composer's prompt, and an in-place item of the title menu hands
 * the keyboard to the thread's prompt (focusPromptAfterMenu), so closing must not move
 * focus back to the menu's trigger. True when it should stay where the item put it.
 */
export function keepFocusAfterMenu(id: string): boolean {
  const ui = useUiStore.getState();
  return inPlace === id || ui.renamingThreadId === id || (ui.selection.kind === "compose" && ui.selection.likeThreadId === id);
}

/** After keepFocusAfterMenu: when an in-place item closed the menu, asks the selected thread's prompt for the keyboard. */
export function focusPromptAfterMenu(id: string): void {
  if (inPlace !== id) return;
  inPlace = null;
  const sel = useUiStore.getState().selection;
  if (sel.kind === "thread" && sel.id === id) useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
}
