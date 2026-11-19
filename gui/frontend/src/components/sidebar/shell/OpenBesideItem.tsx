import { ContextMenuItem, ContextMenuSeparator } from "@/components/ui/context-menu";
import type { LinkedAction } from "@/shell/linked";
import { besidePane, useThreadsOpenAs } from "@/shell/threadsOpenAs";
import { useLayoutStore } from "@/stores/layout";

/**
 * First in a thread row's Open ▸ under Threads open as Panes (docs/notes/threads-open-as-2-gui.md):
 * opens the thread in a new thread pane on the right of the one a click would replace
 * (thread.open --beside). Not under Tabs (a click adds a tab) nor Single (one thread pane per space).
 */
export function OpenBesideItem({ threadId, onPick }: { threadId: string; onPick: (a: LinkedAction) => void }) {
  const mode = useThreadsOpenAs();
  const pane = useLayoutStore((s) => (mode === "panes" ? besidePane(s, threadId) : ""));
  if (!pane) return null;
  return (
    <>
      <ContextMenuItem
        data-testid="row-menu-open-beside"
        onSelect={() => {
          onPick({ run: "thread.open", args: { id: threadId, beside: pane, focus: "true" } });
        }}
      >
        Open beside
      </ContextMenuItem>
      <ContextMenuSeparator />
    </>
  );
}
