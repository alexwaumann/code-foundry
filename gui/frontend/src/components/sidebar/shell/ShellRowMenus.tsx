import { useRef } from "react";
import { ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu";
import { MoveToSpaceItems, ThreadSurfaceItems } from "@/components/shell/ThreadSurfaceItems";
import { contextMenuKit } from "@/components/thread/menuKit";
import type { LinkedAction } from "@/shell/linked";
import { runLinked } from "@/shell/linkedRun";
import { discardDraft, openDraft } from "@/shell/drafts";
import { spaceOfThread, useLayoutStore } from "@/stores/layout";
import { RowMenu } from "../RowMenu";

/**
 * A shell thread row's context menu: Open ▸ first (the thread's diff per checkout, its pull
 * requests, its terminal tabs and New terminal tab: the thread header's items, ThreadSurfaceItems),
 * Move to space ▸ (the header's MoveToSpaceItems: thread.space.move, its linked tabs go along; or
 * New space), then the classic row's items (RowMenu: rename, pin, snooze, archive, …, fork, remove) without its old
 * "New terminal here" (Open ▸ has New terminal tab). For a thread whose tab is open the items follow the placement rules;
 * for a closed one they open in the focused pane (the daemon's rule for a thread not open).
 * Plugins will add thread actions here.
 */
export function ShellRowMenu({ id }: { id: string }) {
  const spaceId = useLayoutStore((s) => spaceOfThread(s, id));
  // An item that moved the keyboard (into a tab) keeps it there when the menu closes.
  const moved = useRef(false);
  const pick = (a: LinkedAction) => {
    moved.current = !("say" in a);
    // The row's thread is the verb's context, not the window's: a verb is available, and its
    // defaults resolve, for the thread the menu belongs to (the header's is always the window's).
    void runLinked("run" in a && !a.thread ? { ...a, thread: id } : a);
  };
  return (
    <RowMenu
      id={id}
      keepFocus={() => {
        const m = moved.current;
        moved.current = false;
        return m;
      }}
      lead={
        <>
          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="row-menu-open">Open</ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-52" data-testid="row-menu-open-surfaces">
              <ThreadSurfaceItems threadId={id} spaceId={spaceId} kit={contextMenuKit} onPick={pick} />
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSub>
            <ContextMenuSubTrigger data-testid="row-menu-move-to-space">Move to space</ContextMenuSubTrigger>
            <ContextMenuSubContent className="min-w-44" data-testid="row-menu-move-to-space-spaces">
              <MoveToSpaceItems threadId={id} kit={contextMenuKit} onPick={pick} />
            </ContextMenuSubContent>
          </ContextMenuSub>
          <ContextMenuSeparator />
        </>
      }
    />
  );
}

/** A draft row's context menu: Open (composer.draft.open) and Discard (composer.draft.discard). */
export function DraftRowMenu({ id }: { id: string }) {
  const moved = useRef(false);
  return (
    <ContextMenuContent
      data-testid="draft-menu"
      data-draft={id}
      onCloseAutoFocus={(e) => {
        if (!moved.current) return;
        moved.current = false;
        e.preventDefault();
      }}
    >
      <ContextMenuItem
        data-testid="draft-menu-open"
        onSelect={() => {
          moved.current = true;
          void openDraft(id);
        }}
      >
        Open
      </ContextMenuItem>
      <ContextMenuItem
        variant="destructive"
        data-testid="draft-menu-discard"
        onSelect={() => {
          void discardDraft(id);
        }}
      >
        Discard
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
