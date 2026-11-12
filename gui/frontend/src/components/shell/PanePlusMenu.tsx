import { useRef, useState } from "react";
import { Folders, GitPullRequest, MessageSquare, Plus, SquareTerminal } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { formatChord } from "@/keys/chord";
import { plusAction, type LinkedAction, type PlusItem } from "@/shell/linked";
import { runLinked } from "@/shell/linkedRun";
import { useThreadName } from "@/shell/useThreadName";
import { useLayoutStore } from "@/stores/layout";
import { ThreadDot } from "./ThreadDot";
import { ThreadSurfaceItems } from "./ThreadSurfaceItems";

const GENERAL: readonly { item: PlusItem; label: string; icon: typeof Plus; chord?: string }[] = [
  { item: "new-thread", label: "New thread", icon: MessageSquare, chord: "cmd+n" },
  { item: "terminal", label: "Terminal", icon: SquareTerminal },
  { item: "prs", label: "Pull Requests", icon: GitPullRequest },
  { item: "projects", label: "Projects", icon: Folders },
];

/** The thread of the pane's active tab when that tab is a thread's own; "". */
function useActiveThread(paneId: string): string {
  return useLayoutStore((s) => {
    const p = s.panes[paneId];
    const t = p ? s.tabs[p.active] : undefined;
    return t?.kind === "thread" ? t.thread : "";
  });
}

function ThreadSub({ threadId, paneId, spaceId, pick }: { threadId: string; paneId: string; spaceId: string; pick: (a: LinkedAction) => void }) {
  const name = useThreadName(threadId);
  return (
    <>
      <DropdownMenuLabel className="text-caption text-cf-text-muted">This thread</DropdownMenuLabel>
      <DropdownMenuSub>
        <DropdownMenuSubTrigger data-testid="plus-thread">
          <ThreadDot threadId={threadId} className="mx-[5px]" />
          <span className="truncate">{name}</span>
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent className="min-w-52" data-testid="plus-thread-surfaces">
          <ThreadSurfaceItems threadId={threadId} spaceId={spaceId} pane={paneId} onPick={pick} />
        </DropdownMenuSubContent>
      </DropdownMenuSub>
      <DropdownMenuSeparator />
    </>
  );
}

/**
 * A pane's "+" (docs/notes/shell-model.md, "Structure"): a menu of surfaces after the strip's
 * last tab. With a thread's tab active, first a submenu of that thread's surfaces (the header's
 * Open ▸ items); then New thread, Terminal (a free one), Pull Requests and Projects. The choice
 * opens in this pane (`--pane`), except a linked surface already open, which is focused where it
 * is (shell/linked.ts). Keyboard: Enter or Space opens it, arrows move, right opens the submenu.
 */
export function PanePlusMenu({ paneId }: { paneId: string }) {
  const threadId = useActiveThread(paneId);
  const spaceId = useLayoutStore((s) => s.panes[paneId]?.spaceId ?? "");
  const [open, setOpen] = useState(false);
  // A pick that moves the keyboard (a tab, a composer) keeps it there when the menu closes.
  const picked = useRef(false);
  const pick = (a: LinkedAction) => {
    picked.current = !("say" in a);
    void runLinked(a);
  };
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <Tip label="Open a tab">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Open a tab"
            className="flex size-7 shrink-0 cursor-default items-center justify-center rounded-md text-cf-text-muted outline-none [--wails-draggable:no-drag] hover:bg-cf-control-hover/40 hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus aria-expanded:bg-cf-control-hover/40 aria-expanded:text-cf-text"
            data-testid="pane-plus"
            // Not the pane's drag grip (the strip's free space): a press here opens the menu only.
            onPointerDown={(e) => {
              e.stopPropagation();
            }}
          >
            <Plus className="size-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        align="start"
        className="min-w-52"
        data-testid="pane-plus-menu"
        onCloseAutoFocus={(e) => {
          if (!picked.current) return;
          picked.current = false;
          e.preventDefault();
        }}
      >
        {threadId && <ThreadSub threadId={threadId} paneId={paneId} spaceId={spaceId} pick={pick} />}
        {GENERAL.map(({ item, label, icon: Icon, chord }) => (
          <DropdownMenuItem
            key={item}
            data-testid="plus-item"
            data-item={item}
            onSelect={() => {
              pick(plusAction(item, paneId));
            }}
          >
            <Icon />
            {label}
            {chord && <DropdownMenuShortcut>{formatChord(chord)}</DropdownMenuShortcut>}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
