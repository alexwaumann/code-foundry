import { useContext, useState, type KeyboardEvent, type PointerEvent } from "react";
import { ChevronRight, SquareArrowOutUpRight } from "lucide-react";
import { AppIcon, FinderIcon } from "@/components/icons/AppIcon";
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu";
import { runCommand } from "@/stores/commands";
import { worktreeContext } from "@/stores/context";
import { newTerminalIn } from "@/stores/projectActions";
import { useEditorApps } from "@/stores/threadInfo";
import { RowMenuPickContext } from "./RowContextMenu";

/** worktree.reveal: the checkout in Finder. */
function revealCheckout(projectId: string, path: string): void {
  void runCommand("worktree.reveal", { worktree: path }, worktreeContext(projectId, path));
}

/** worktree.open.editor: the checkout in an installed editor. */
function openInEditor(projectId: string, path: string, app: string): void {
  void runCommand("worktree.open.editor", { worktree: path, app }, worktreeContext(projectId, path));
}

const onMore = (t: EventTarget | null): boolean => t instanceof Element && t.closest("[data-open-in-more]") !== null;

/**
 * The item: its left block is its `before:` (left edge to 34px short of the right: the 32px ›
 * block and the 2px seam), bright while highlighted, half strength while the › block is hovered
 * or its submenu is open. No tint of its own (the trigger's focus and open backgrounds cleared);
 * `isolate` so both blocks (z -1) paint under the text and the glyph. As GearMenuItem's
 * GEAR_ITEM (docs/notes/thread-info-split-hover.md).
 */
export const OPEN_IN_ITEM =
  "group/split isolate focus:bg-transparent data-[state=open]:bg-transparent before:pointer-events-none before:absolute before:inset-y-0 before:right-8.5 before:left-0 before:-z-1 before:rounded-l-md data-highlighted:before:bg-cf-control-hover data-[state=open]:before:bg-cf-control-hover/50 has-[[data-open-in-more]:hover]:before:bg-cf-control-hover/50";

/**
 * The › block: a 16px box on the item's right padding (where a submenu's chevron sits), its
 * block the `after:`, the item's last 32px at its full height (the hit area: the span is
 * static, the item `relative`). Half strength while the item is highlighted, bright under the
 * pointer or while the submenu is open. The chevron always shows: it marks a submenu.
 */
export const OPEN_IN_MORE =
  "ml-auto flex size-4 shrink-0 items-center justify-center text-cf-text-muted after:absolute after:inset-y-0 after:right-0 after:-z-1 after:w-8 after:rounded-r-md group-data-highlighted/split:after:bg-cf-control-hover/50 group-data-[state=open]/split:text-cf-text group-data-[state=open]/split:after:bg-cf-control-hover hover:text-cf-text hover:after:bg-cf-control-hover";

/**
 * "Open in Finder" as a split item of a row's right-click menu (docs/notes/project-page-2-checkouts.md):
 * a click on it (or Enter, Space) reveals the checkout in Finder and closes the menu; its › block
 * at the right opens a submenu (hover there, a click on it, or ArrowRight) with Finder, the
 * installed editors (their real icons) and, after a separator, Terminal (a new terminal in the
 * checkout). It hovers as two blocks like the thread info card's Actions items with their gear.
 *
 * It is a Radix sub trigger whose own opening is kept to the › block: a pointer move over the
 * rest focuses the item without Radix (which would open the submenu) and closes a submenu left
 * open; a click there is not Radix's (which opens it) but the reveal, through the row menu's
 * `close` (the trigger is not an item Radix selects). Its keys: Enter and Space reveal,
 * ArrowRight opens the submenu (Radix).
 */
export function OpenInSplitItem({ projectId, path, testId }: { projectId: string; path: string; testId: string }) {
  const { pick, close } = useContext(RowMenuPickContext);
  const editors = useEditorApps();
  const [open, setOpen] = useState(false);
  const reveal = (from: HTMLElement) => {
    const run = () => {
      revealCheckout(projectId, path);
    };
    if (!open) {
      close(run, from);
      return;
    }
    // A submenu still open would take the Escape that closes the menu: close it first.
    setOpen(false);
    requestAnimationFrame(() => {
      close(run, from);
    });
  };
  return (
    <ContextMenuSub open={open} onOpenChange={setOpen}>
      <ContextMenuSubTrigger
        chevron={false}
        className={OPEN_IN_ITEM}
        data-testid={testId}
        onPointerMove={(e: PointerEvent<HTMLDivElement>) => {
          if (e.pointerType !== "mouse" || onMore(e.target)) return;
          e.preventDefault();
          if (open) setOpen(false);
          if (document.activeElement !== e.currentTarget) e.currentTarget.focus({ preventScroll: true });
        }}
        onClick={(e) => {
          if (onMore(e.target)) return;
          e.preventDefault();
          reveal(e.currentTarget);
        }}
        onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          reveal(e.currentTarget);
        }}
      >
        Open in Finder
        <span data-open-in-more="" data-testid={`${testId}-more`} className={OPEN_IN_MORE} aria-hidden>
          <ChevronRight className="size-4 text-current" />
        </span>
      </ContextMenuSubTrigger>
      <ContextMenuSubContent className="min-w-48" data-testid={`${testId}-menu`}>
        <ContextMenuItem
          data-testid="open-in-finder"
          onSelect={() => {
            pick(() => {
              revealCheckout(projectId, path);
            });
          }}
        >
          <FinderIcon />
          Finder
        </ContextMenuItem>
        {editors.map((a) => (
          <ContextMenuItem
            key={a.bundleId}
            data-testid="open-in-editor"
            data-app={a.bundleId}
            onSelect={() => {
              pick(() => {
                openInEditor(projectId, path, a.bundleId);
              });
            }}
          >
            <AppIcon bundleId={a.bundleId} fallback={SquareArrowOutUpRight} />
            {a.name}
          </ContextMenuItem>
        ))}
        <ContextMenuSeparator />
        <ContextMenuItem
          data-testid="open-in-terminal"
          onSelect={() => {
            pick(() => void newTerminalIn(projectId, path));
          }}
        >
          Terminal
        </ContextMenuItem>
      </ContextMenuSubContent>
    </ContextMenuSub>
  );
}
