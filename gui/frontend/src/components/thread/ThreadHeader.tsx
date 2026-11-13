import { useRef, useState } from "react";
import { GitBranch, House, Loader2, MoreHorizontal } from "lucide-react";
import { MoveToSpaceItems, ThreadSurfaceItems } from "@/components/shell/ThreadSurfaceItems";
import { ThreadInfoToggle } from "@/components/threadinfo/ThreadInfoToggle";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { formatChord } from "@/keys/chord";
import { movingLabel } from "@/lib/move";
import { cn } from "@/lib/utils";
import { closeThreadAction, type LinkedAction } from "@/shell/linked";
import { runLinked } from "@/shell/linkedRun";
import { usePaneTabCut } from "@/shell/tabCut";
import { useLayoutStore } from "@/stores/layout";
import { useThreadsStore } from "@/stores/threads";
import { dropdownMenuKit, focusPromptAfterMenu, keepFocusAfterMenu } from "./menuKit";
import { MovePicker } from "./MovePicker";
import { ThreadMenuItems } from "./ThreadMenuItems";
import { TranscriptDeletedChip } from "./TranscriptDeleted";
import { useCanMove } from "./useNoProject";
import { useMovingTo } from "./useMovingTo";
import { useThreadPlace } from "./useThreadPlace";

/** The quiet chip the header shows the branch in (and, for a thread with no project, where it runs). */
const CHIP = "flex h-6 min-w-0 items-center gap-1 rounded-md bg-cf-control-hover/50 px-1.5 text-label text-cf-text-muted";

/**
 * Where the thread works: its branch as a chip; a thread with no project says so instead, and
 * (while it can move) opens the move picker, which the menu's "Move to project…" also opens.
 * While a move is in flight (sent, or the daemon's pending move), it says where to.
 */
function PlaceChip({ threadId }: { threadId: string }) {
  // The sidebar row's branch (lib/threadRow): the checkout's, else the short head or folder.
  const { branch, noProject } = useThreadPlace(threadId);
  const movable = useCanMove(threadId);
  const moving = useMovingTo(threadId);
  if (moving !== null) {
    return (
      <span className={CHIP} data-testid="thread-header-moving">
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        <span className="truncate">{movingLabel(moving)}</span>
      </span>
    );
  }
  if (noProject) {
    const content = (
      <>
        <House className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate">No project</span>
      </>
    );
    return movable ? (
      <span className="flex min-w-0 text-label text-cf-text-muted" data-testid="thread-header-place">
        <MovePicker threadId={threadId}>{content}</MovePicker>
      </span>
    ) : (
      <span className={CHIP} data-testid="thread-header-place">
        {content}
      </span>
    );
  }
  if (!branch) return null;
  return (
    <span className={CHIP} data-testid="thread-header-branch">
      <GitBranch className="size-3.5 shrink-0" aria-hidden />
      <Tip label={branch} whenTruncated side="bottom">
        <span className="truncate font-mono text-caption">{branch}</span>
      </Tip>
    </span>
  );
}

/**
 * The thread's one menu (docs/notes/shell-model.md, "The thread's header"): Open ▸ (its surfaces,
 * shell/linked.ts), Move to space ▸, the thread's own items (the sidebar row's, ThreadMenuItems:
 * rename, pin, snooze, archive, …), then Close (thread.close: its tab leaves the space).
 */
function ThreadHeaderMenu({ threadId, paneId }: { threadId: string; paneId: string }) {
  const spaceId = useLayoutStore((s) => s.panes[paneId]?.spaceId ?? "");
  const [open, setOpen] = useState(false);
  // An item that moved the keyboard (to a tab) keeps it there when the menu closes.
  const moved = useRef(false);
  const pick = (a: LinkedAction) => {
    moved.current = !("say" in a);
    void runLinked(a);
  };
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <Tip label="Thread menu">
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Thread menu"
            className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md text-cf-text-muted outline-none [--wails-draggable:no-drag] hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus aria-expanded:bg-cf-control-hover aria-expanded:text-cf-text dark:hover:bg-cf-control-hover/50 dark:aria-expanded:bg-cf-control-hover/50"
            data-testid="thread-header-menu-trigger"
          >
            <MoreHorizontal className="size-4" aria-hidden />
          </button>
        </DropdownMenuTrigger>
      </Tip>
      <DropdownMenuContent
        align="end"
        className="min-w-52"
        data-testid="thread-header-menu"
        onCloseAutoFocus={(e) => {
          if (moved.current) {
            moved.current = false;
            e.preventDefault();
            return;
          }
          if (!keepFocusAfterMenu(threadId)) return;
          e.preventDefault();
          focusPromptAfterMenu(threadId);
        }}
      >
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="menu-open">Open</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-52" data-testid="menu-open-surfaces">
            <ThreadSurfaceItems threadId={threadId} spaceId={spaceId} onPick={pick} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger data-testid="menu-move-to-space">Move to space</DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="min-w-44" data-testid="menu-move-to-space-spaces">
            <MoveToSpaceItems threadId={threadId} onPick={pick} />
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuSeparator />
        <ThreadMenuItems id={threadId} kit={dropdownMenuKit} />
        <DropdownMenuItem
          data-testid="menu-close"
          onSelect={() => {
            pick(closeThreadAction(threadId));
          }}
        >
          Close
          <DropdownMenuShortcut>{formatChord("cmd+w")}</DropdownMenuShortcut>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * A thread's header in a shell pane (docs/notes/shell-model.md, "The thread's header"): the
 * branch chip, then the thread info toggle and one three-dot menu. The tab above is the title:
 * the header names the thread only while that tab's name is cut short or hidden (shell/tabCut.ts),
 * so the name is on screen once.
 */
export function ThreadHeader({ threadId, paneId }: { threadId: string; paneId: string }) {
  const cut = usePaneTabCut(paneId);
  const name = useThreadsStore((s) => s.byId[threadId]?.name || threadId);
  return (
    <header className="flex h-10 shrink-0 items-center gap-2 border-b border-cf-divider px-3" data-testid="thread-header" data-shell="">
      <span className="flex min-w-0 flex-1 items-center gap-2" data-testid="thread-title-bar">
        {cut && (
          <span className={cn("min-w-0 shrink-[100] truncate text-label font-medium text-cf-text")} data-testid="thread-header-name">
            {name}
          </span>
        )}
        <PlaceChip threadId={threadId} />
        <TranscriptDeletedChip id={threadId} />
      </span>
      <span className="-mr-1 flex shrink-0 items-center gap-0.5 text-cf-text-muted [--wails-draggable:no-drag]" data-testid="pane-actions">
        <ThreadInfoToggle />
        <ThreadHeaderMenu threadId={threadId} paneId={paneId} />
      </span>
    </header>
  );
}
