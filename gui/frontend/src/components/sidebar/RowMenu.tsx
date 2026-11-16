import type { ReactNode } from "react";
import { ContextMenuContent } from "@/components/ui/context-menu";
import { contextMenuKit, keepFocusAfterMenu } from "@/components/thread/menuKit";
import { ThreadMenuItems } from "@/components/thread/ThreadMenuItems";

/**
 * The context menu of a thread row: `lead` (the shell's row puts its Open ▸ and Move to space ▸
 * there, sidebar/shell), then the thread's menu items, shared verbatim with the thread header's
 * menu and the thread tab's (ThreadMenuItems: rename … archive, fork, remove).
 */
export function RowMenu({ id, lead, keepFocus }: { id: string; lead?: ReactNode; keepFocus?: () => boolean }) {
  return (
    <ContextMenuContent
      data-testid="row-menu"
      data-thread={id}
      onCloseAutoFocus={(e) => {
        // keepFocus: an item of `lead` moved the keyboard (into a tab it opened or focused).
        if (keepFocus?.() || keepFocusAfterMenu(id)) e.preventDefault();
      }}
    >
      {lead}
      <ThreadMenuItems id={id} kit={contextMenuKit} />
    </ContextMenuContent>
  );
}
