import type { ReactNode } from "react";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { contextMenuKit, keepFocusAfterMenu } from "@/components/thread/menuKit";
import { ThreadMenuItems } from "@/components/thread/ThreadMenuItems";
import { isUnplaced, setupUnfinished } from "@/lib/threadSetup";
import { newThreadTerminal } from "@/stores/bottomActions";
import { forkThread, removeThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";

/**
 * The context menu of a thread row: the thread's menu items, shared verbatim with the
 * thread header's title menu (ThreadMenuItems), then what only the row offers: a new
 * terminal in the thread's checkout, Fork and Remove. A setup that did not finish forks
 * nothing, and a terminal needs a checkout. The shell's row (sidebar/shell) puts its Open ▸ first
 * (`lead`) and leaves out the bottom panel's terminal (`terminal`), which Open ▸ has as a tab.
 */
export function RowMenu({ id, lead, terminal = true, keepFocus }: { id: string; lead?: ReactNode; terminal?: boolean; keepFocus?: () => boolean }) {
  const transcriptMissing = useThreadsStore((s) => s.byId[id]?.transcriptMissing === true);
  const unplaced = useThreadsStore((s) => isUnplaced(s.byId[id]));
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
      {terminal && !unplaced && (
        <ContextMenuItem
          onSelect={() => {
            void newThreadTerminal(id);
          }}
        >
          New terminal here
        </ContextMenuItem>
      )}
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
