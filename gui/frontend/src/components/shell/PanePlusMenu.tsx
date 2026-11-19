import { Fragment, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
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
import { terminalName } from "@/lib/terminalName";
import { plusAction, showTerminalAction, tabbedTerminalIds, untabbedTerminals, type LinkedAction, type PlusItem } from "@/shell/linked";
import { runLinked } from "@/shell/linkedRun";
import { useThreadsOpenAs, type ThreadsOpenAs } from "@/shell/threadsOpenAs";
import { useThreadName } from "@/shell/useThreadName";
import { paneTakesAnyTab } from "@/shell/drag/room";
import { geoTree, useLayoutStore } from "@/stores/layout";
import { useShellViewStore } from "@/stores/shellView";
import { useTerminalsStore } from "@/stores/terminals";
import { PlusPluginItems } from "./PluginSurfaceItems";
import { TERMINAL_ICONS } from "./terminalIcons";
import { ThreadDot } from "./ThreadDot";
import { ThreadSurfaceItems } from "./ThreadSurfaceItems";

type GeneralItem = { item: PlusItem; label: string; icon: typeof Plus; chord?: string };

const GENERAL: readonly GeneralItem[] = [
  { item: "new-thread", label: "New thread", icon: MessageSquare, chord: "cmd+n" },
  { item: "terminal", label: "Terminal", icon: SquareTerminal },
  { item: "prs", label: "Pull Requests", icon: GitPullRequest },
  { item: "projects", label: "Projects", icon: Folders },
];

/**
 * A thread pane's general items (docs/notes/shell-model.md, "A thread pane's header"): nothing
 * opens as a tab in that pane, so New thread is New thread beside under Panes (a composer in a
 * new pane on its right; cmd+n is not that, so no chord) and is left out under Single (one thread
 * pane per space: New thread would only replace this pane's thread, which cmd+n and the sidebar do).
 * Also left out in the pane of the space's empty composer: a space has one, so it would only be
 * focused where it is.
 */
function threadPaneGeneral(mode: ThreadsOpenAs, emptyComposer: boolean): readonly GeneralItem[] {
  return GENERAL.flatMap((g): GeneralItem[] => {
    if (g.item !== "new-thread") return [g];
    return mode === "single" || emptyComposer ? [] : [{ item: "new-thread-beside", label: "New thread beside", icon: MessageSquare }];
  });
}

/** The thread of the pane's active tab when that tab is a thread's own; "". */
function useActiveThread(paneId: string): string {
  return useLayoutStore((s) => {
    const p = s.panes[paneId];
    const t = p ? s.tabs[p.active] : undefined;
    return t?.kind === "thread" ? t.thread : "";
  });
}

/**
 * Whether the pane can take a tab other than a terminal (shell/drag/room.ts paneTakesAnyTab): a
 * pane of terminals with no room to grow to a pane's minimum cannot, and its "+" lists only
 * terminals (docs/notes/shell-model.md, "A pane's +"). Before the grid has measured, it can.
 */
function useTakesAnyTab(paneId: string, spaceId: string): boolean {
  const w = useShellViewStore((s) => s.frame?.w ?? 0);
  const h = useShellViewStore((s) => s.frame?.h ?? 0);
  return useLayoutStore((s) => !(w > 0 && h > 0) || paneTakesAnyTab(geoTree(s, spaceId), paneId, { w, h }));
}

/** The ids of the running terminals no tab shows (shell/linked.ts untabbedTerminals). */
function useUntabbedTerminals(): string[] {
  const tabbed = useLayoutStore(useShallow((s) => tabbedTerminalIds(s.tabs)));
  return useTerminalsStore(useShallow((s) => untabbedTerminals(s.byId, s.order, tabbed).map((t) => t.id)));
}

/** A running terminal with no tab, under Terminal: named as its tab would be; a pick gives it a tab in this pane. */
function UntabbedTerminalItem({ id, pick, paneId }: { id: string; paneId: string; pick: (a: LinkedAction) => void }) {
  const named = useTerminalsStore(
    useShallow((s) => {
      const t = s.byId[id];
      return t ? terminalName({ manual: "", argv: t.argv, dir: t.liveCwd || t.cwd, foreground: t.foreground, labels: t.labels }) : { name: id, icon: "shell" as const, auto: true };
    }),
  );
  const Icon = TERMINAL_ICONS[named.icon];
  return (
    <DropdownMenuItem
      className="pl-7"
      data-testid="plus-untabbed-terminal"
      data-terminal-id={id}
      onSelect={() => {
        pick(showTerminalAction(id, paneId));
      }}
    >
      <Icon />
      <span className="truncate">{named.name}</span>
    </DropdownMenuItem>
  );
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

/** A thread pane's own thread: its surfaces at the top level under the label, no submenu (the pane is that thread). */
function ThreadGroup({ threadId, paneId, spaceId, pick }: { threadId: string; paneId: string; spaceId: string; pick: (a: LinkedAction) => void }) {
  return (
    <>
      <DropdownMenuLabel className="text-caption text-cf-text-muted">This thread</DropdownMenuLabel>
      <ThreadSurfaceItems threadId={threadId} spaceId={spaceId} pane={paneId} onPick={pick} />
      <DropdownMenuSeparator />
    </>
  );
}

/** The general items for a strip's "+", or a thread pane's under the mode. */
function useGeneral(paneId: string, threadPane: boolean): readonly GeneralItem[] {
  const mode = useThreadsOpenAs();
  const emptyComposer = useLayoutStore((s) => {
    const p = s.panes[paneId];
    const t = p ? s.tabs[p.active] : undefined;
    return t?.kind === "compose" && !t.params.draft;
  });
  return threadPane ? threadPaneGeneral(mode, emptyComposer) : GENERAL;
}

/**
 * A pane's "+" (docs/notes/shell-model.md, "Structure"): a menu of surfaces after the strip's
 * last tab. With a thread's tab active, first a submenu of that thread's surfaces (the header's
 * Open ▸ items, its plugin surfaces among them); then New thread, Terminal (a free one), Pull
 * Requests and Projects; then, under a Plugins label, each plugin surface of no thread that can
 * show here (components/shell/PluginSurfaceItems.tsx). The choice
 * opens in this pane (`--pane`), except a linked surface already open, which is focused where it
 * is (shell/linked.ts). Under Terminal, the running terminals that have no tab (a classic bottom
 * panel's shells): a pick gives one a tab here. In a pane of terminals that has no room for
 * anything else, only Terminal (and the untabbed ones), no plugin surface. Keyboard: Enter or Space opens it,
 * arrows move, right opens the submenu.
 *
 * `threadPane`: the "+" of a thread pane's header row under Panes and Single
 * (ThreadPaneHeader.tsx), where nothing it lists opens as a tab in that pane. It is named "Open",
 * the thread's surfaces are top-level items under "This thread" (no submenu: the pane is that
 * thread), and New thread is New thread beside under Panes and absent under Single
 * (threadPaneGeneral). The rest is the strip's.
 */
export function PanePlusMenu({ paneId, threadPane = false }: { paneId: string; threadPane?: boolean }) {
  const threadId = useActiveThread(paneId);
  const general = useGeneral(paneId, threadPane);
  const name = threadPane ? "Open" : "Open a tab";
  const spaceId = useLayoutStore((s) => s.panes[paneId]?.spaceId ?? "");
  const untabbed = useUntabbedTerminals();
  const anyTab = useTakesAnyTab(paneId, spaceId);
  const [open, setOpen] = useState(false);
  // A pick that moves the keyboard (a tab, a composer) keeps it there when the menu closes.
  const picked = useRef(false);
  const pick = (a: LinkedAction) => {
    picked.current = !("say" in a);
    void runLinked(a);
  };
  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <Tip label={name}>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label={name}
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
        {threadId && (threadPane ? <ThreadGroup threadId={threadId} paneId={paneId} spaceId={spaceId} pick={pick} /> : <ThreadSub threadId={threadId} paneId={paneId} spaceId={spaceId} pick={pick} />)}
        {general.filter(({ item }) => anyTab || item === "terminal").map(({ item, label, icon: Icon, chord }) => (
          <Fragment key={item}>
            <DropdownMenuItem
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
            {item === "terminal" && untabbed.map((id) => <UntabbedTerminalItem key={id} id={id} paneId={paneId} pick={pick} />)}
          </Fragment>
        ))}
        {anyTab && <PlusPluginItems paneId={paneId} pick={pick} />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
