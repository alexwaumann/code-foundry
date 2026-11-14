import type { ReactNode } from "react";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { contextMenuKit, keepFocusAfterMenu } from "@/components/thread/menuKit";
import { ThreadMenuItems } from "@/components/thread/ThreadMenuItems";
import { setupUnfinished } from "@/lib/threadSetup";
import { forkThread, removeThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";

/**
 * The context menu of a thread row: `lead` (the shell's row puts its Open ▸ and Move to space ▸
 * there, sidebar/shell), the thread's menu items, shared verbatim with the thread header's menu
 * (ThreadMenuItems), then what only the row offers: Fork and Remove. A setup that did not finish
 * forks nothing.
 */
export function RowMenu({ id, lead, keepFocus }: { id: string; lead?: ReactNode; keepFocus?: () => boolean }) {
  const transcriptMissing = useThreadsStore((s) => s.byId[id]?.transcriptMissing === true);
  const unfinished = useThreadsStore((s) => setupUnfinished(s.byId[id]?.setup));
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
      <ContextMenuSeparator />
      {!unfinished && (
        <ContextMenuItem
          data-testid="menu-fork"
          // Nothing to fork from once Claude Code deleted the transcript (docs/notes/transcript-deleted.md).
          disabled={transcriptMissing}
          onSelect={() => {
            void forkThread(id);
          }}
        >
          Fork
        </ContextMenuItem>
      )}
      <ContextMenuItem
        variant="destructive"
        onSelect={() => {
          void removeThread(id);
        }}
      >
        Remove
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
