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
}

export const contextMenuKit: MenuKit = {
  Item: ContextMenuItem,
  Separator: ContextMenuSeparator,
  Label: ContextMenuLabel,
  Sub: ContextMenuSub,
  SubTrigger: ContextMenuSubTrigger,
  SubContent: ContextMenuSubContent,
};

export const dropdownMenuKit: MenuKit = {
  Item: DropdownMenuItem,
  Separator: DropdownMenuSeparator,
  Label: DropdownMenuLabel,
  Sub: DropdownMenuSub,
  SubTrigger: DropdownMenuSubTrigger,
  SubContent: DropdownMenuSubContent,
};

/**
 * For a menu's onCloseAutoFocus: Rename puts an input in the sidebar row, and New thread
 * on this branch focuses the composer's prompt, so closing must not move focus back to
 * the menu's trigger. True when it should stay where the item put it.
 */
export function keepFocusAfterMenu(id: string): boolean {
  const ui = useUiStore.getState();
  return ui.renamingThreadId === id || (ui.selection.kind === "compose" && ui.selection.likeThreadId === id);
}
