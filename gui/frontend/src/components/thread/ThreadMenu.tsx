import { MoveToSpaceItems, ThreadSurfaceItems } from "@/components/shell/ThreadSurfaceItems";
import { formatChord } from "@/keys/chord";
import { closeThreadAction, type LinkedAction } from "@/shell/linked";
import { runLinked } from "@/shell/linkedRun";
import { keepPreviewTab } from "@/shell/preview";
import { useLayoutStore, type TabEntry } from "@/stores/layout";
import { markTabMenuMoved, tabMenuKit, type MenuKit } from "./menuKit";
import { ThreadMenuItems } from "./ThreadMenuItems";

/**
 * The thread's one menu (docs/notes/shell-model.md, "The thread's header"), as the header's
 * "…" and a right click on the thread's tab both show it: for a preview tab, Keep open
 * (tab.keep), then Open ▸ (its surfaces, shell/linked.ts), Move to space ▸, the thread's own
 * items (the sidebar row's, ThreadMenuItems: rename, pin, snooze, archive, …, fork, remove), with
 * Close (thread.close: its tab leaves the space) after Archive. `preview`: the id of the thread's
 * tab when it is a preview. `onPick` runs an Open ▸ item or Close.
 */
export function ThreadMenuBody({ threadId, spaceId, preview, kit, onPick }: { threadId: string; spaceId: string; preview: string; kit: MenuKit; onPick: (a: LinkedAction) => void }) {
  return (
    <>
      {preview && (
        <>
          <kit.Item
            data-testid="menu-keep-open"
            onSelect={() => {
              void keepPreviewTab(preview);
            }}
          >
            Keep open
          </kit.Item>
          <kit.Separator />
        </>
      )}
      <kit.Sub>
        <kit.SubTrigger data-testid="menu-open">Open</kit.SubTrigger>
        <kit.SubContent className="min-w-52" data-testid="menu-open-surfaces">
          <ThreadSurfaceItems threadId={threadId} spaceId={spaceId} kit={kit} onPick={onPick} />
        </kit.SubContent>
      </kit.Sub>
      <kit.Sub>
        <kit.SubTrigger data-testid="menu-move-to-space">Move to space</kit.SubTrigger>
        <kit.SubContent className="min-w-44" data-testid="menu-move-to-space-spaces">
          <MoveToSpaceItems threadId={threadId} kit={kit} />
        </kit.SubContent>
      </kit.Sub>
      <kit.Separator />
      <ThreadMenuItems
        id={threadId}
        kit={kit}
        afterArchive={
          <kit.Item
            data-testid="menu-close"
            onSelect={() => {
              onPick(closeThreadAction(threadId));
            }}
          >
            Close
            <kit.Shortcut>{formatChord("cmd+w")}</kit.Shortcut>
          </kit.Item>
        }
      />
    </>
  );
}

/** A thread tab's context menu (ShellSurface.tabMenu): the header's menu, for the tab's thread. */
export function ThreadTabMenu({ tab }: { tab: TabEntry }) {
  const spaceId = useLayoutStore((s) => s.panes[tab.paneId]?.spaceId ?? "");
  return (
    <ThreadMenuBody
      threadId={tab.thread}
      spaceId={spaceId}
      preview={tab.preview ? tab.id : ""}
      kit={tabMenuKit}
      onPick={(a) => {
        if (!("say" in a)) markTabMenuMoved(tab.thread);
        // The tab's thread is the verb's context, not the window's: the tab may not be the focused one.
        void runLinked("run" in a && !a.thread ? { ...a, thread: tab.thread } : a);
      }}
    />
  );
}
