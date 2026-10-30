import { GitFork, SquareTerminal, Trash2 } from "lucide-react";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import { contextMenuKit, keepFocusAfterMenu } from "@/components/thread/menuKit";
import { ThreadMenuItems } from "@/components/thread/ThreadMenuItems";
import { newThreadTerminal } from "@/stores/bottomActions";
import { forkThread, removeThread } from "@/stores/threadActions";
import { useThreadsStore } from "@/stores/threads";

/**
 * The context menu of a thread row: the thread's menu items, shared verbatim with the
 * thread header's title menu (ThreadMenuItems), then what only the row offers: a new
 * terminal in the thread's checkout, Fork and Remove.
 */
export function RowMenu({ id }: { id: string }) {
  const transcriptMissing = useThreadsStore((s) => s.byId[id]?.transcriptMissing === true);
  return (
    <ContextMenuContent
      data-testid="row-menu"
      data-thread={id}
      onCloseAutoFocus={(e) => {
        if (keepFocusAfterMenu(id)) e.preventDefault();
      }}
    >
      <ThreadMenuItems id={id} kit={contextMenuKit} />
      <ContextMenuSeparator />
      <ContextMenuItem
        onSelect={() => {
          void newThreadTerminal(id);
        }}
      >
        <SquareTerminal />
        New terminal here
      </ContextMenuItem>
      <ContextMenuItem
        data-testid="menu-fork"
        // Nothing to fork from once Claude Code deleted the transcript (docs/notes/transcript-deleted.md).
        disabled={transcriptMissing}
        onSelect={() => {
          void forkThread(id);
        }}
      >
        <GitFork />
        Fork
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        onSelect={() => {
          void removeThread(id);
        }}
      >
        <Trash2 />
        Remove…
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
