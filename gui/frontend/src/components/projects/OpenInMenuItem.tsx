import { useContext, useState, type ComponentType, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { ContextMenuItem, ContextMenuSeparator, ContextMenuSub, ContextMenuSubContent, ContextMenuSubTrigger } from "@/components/ui/context-menu";
import { DropdownMenuItem, DropdownMenuSeparator, DropdownMenuSub, DropdownMenuSubContent, DropdownMenuSubTrigger } from "@/components/ui/dropdown-menu";
import { useEditorApps } from "@/stores/threadInfo";
import { OpenInList } from "./OpenInFinder";
import type { OpenInTarget } from "./openIn";
import type { MenuParts } from "./OverflowMenu";
import { RowMenuPickContext } from "./rowMenu";

/** The submenu primitives of the menu the item is in: a row's right-click menu or a ⋯ dropdown. */
interface SplitParts {
  Sub: ComponentType<{ open: boolean; onOpenChange: (open: boolean) => void; children?: ReactNode }>;
  SubTrigger: ComponentType<{
    chevron: false;
    className: string;
    "data-testid": string;
    onPointerMove: (e: PointerEvent<HTMLDivElement>) => void;
    onClick: (e: React.MouseEvent<HTMLDivElement>) => void;
    onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => void;
    children?: ReactNode;
  }>;
  SubContent: ComponentType<{ className: string; "data-testid": string; children?: ReactNode }>;
  items: MenuParts;
}

const SPLIT_PARTS: Record<"context" | "dropdown", SplitParts> = {
  context: { Sub: ContextMenuSub, SubTrigger: ContextMenuSubTrigger, SubContent: ContextMenuSubContent, items: { Item: ContextMenuItem, Separator: ContextMenuSeparator } },
  dropdown: { Sub: DropdownMenuSub, SubTrigger: DropdownMenuSubTrigger, SubContent: DropdownMenuSubContent, items: { Item: DropdownMenuItem, Separator: DropdownMenuSeparator } },
};

const onMore = (t: EventTarget | null): boolean => t instanceof Element && t.closest("[data-open-in-more]") !== null;

/**
 * The item: its left block is its `before:` (left edge to 34px short of the right: the 32px ›
 * block and the 2px seam), bright while highlighted, half strength while the › block is hovered
 * or its submenu is open. No tint of its own (the trigger's focus and open backgrounds cleared);
 * `isolate` so both blocks (z -1) paint under the text and the glyph. As GearMenuItem's
 * GEAR_ITEM (docs/notes/thread-info-split-hover.md).
 */
export const OPEN_IN_ITEM =
  "group/split relative isolate focus:bg-transparent data-[state=open]:bg-transparent before:pointer-events-none before:absolute before:inset-y-0 before:right-8.5 before:left-0 before:-z-1 before:rounded-l-md data-highlighted:before:bg-cf-control-hover data-[state=open]:before:bg-cf-control-hover/50 has-[[data-open-in-more]:hover]:before:bg-cf-control-hover/50";

/**
 * The › block: a 16px box on the item's right padding (where a submenu's chevron sits), its
 * block the `after:`, the item's last 32px at its full height (the hit area: the span is
 * static, the item `relative`). Half strength while the item is highlighted, bright under the
 * pointer or while the submenu is open. The chevron always shows: it marks a submenu.
 */
export const OPEN_IN_MORE =
  "ml-auto flex size-4 shrink-0 items-center justify-center text-cf-text-muted after:absolute after:inset-y-0 after:right-0 after:-z-1 after:w-8 after:rounded-r-md group-data-highlighted/split:after:bg-cf-control-hover/50 group-data-[state=open]/split:text-cf-text group-data-[state=open]/split:after:bg-cf-control-hover hover:text-cf-text hover:after:bg-cf-control-hover";

/**
 * "Open in Finder" as a split item of a row's right-click menu or a ⋯ dropdown (`menu`;
 * docs/notes/project-page-2-checkouts.md, docs/notes/workspace-page-polish.md): a click on it
 * (or Enter, Space) reveals the target (openIn.ts: a checkout, a workspace's folder) in Finder
 * and closes the menu; its › block at the right opens a submenu (hover there, a click on it, or
 * ArrowRight) with the Open in list Details' ⋯ has (OpenInFinder.tsx OpenInList): Finder, the
 * installed editors (their real icons) and, after a separator, Terminal (a new terminal there).
 * It hovers as two blocks like the thread info card's Actions items with their gear.
 *
 * It is a Radix sub trigger whose own opening is kept to the › block: a pointer move over the
 * rest focuses the item without Radix (which would open the submenu) and closes a submenu left
 * open; a click there is not Radix's (which opens it) but the reveal, through the row menu's
 * `close` (the trigger is not an item Radix selects). Its keys: Enter and Space reveal,
 * ArrowRight opens the submenu (Radix).
 */
export function OpenInSplitItem({ target, testId, menu = "context" }: { target: OpenInTarget; testId: string; menu?: "context" | "dropdown" }) {
  const { pick, close } = useContext(RowMenuPickContext);
  const editors = useEditorApps();
  const [open, setOpen] = useState(false);
  const { Sub, SubTrigger, SubContent, items } = SPLIT_PARTS[menu];
  const reveal = (from: HTMLElement) => {
    const run = target.reveal;
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
    <Sub open={open} onOpenChange={setOpen}>
      <SubTrigger
        chevron={false}
        className={OPEN_IN_ITEM}
        data-testid={testId}
        onPointerMove={(e) => {
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
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          reveal(e.currentTarget);
        }}
      >
        Open in Finder
        <span data-open-in-more="" data-testid={`${testId}-more`} className={OPEN_IN_MORE} aria-hidden>
          <ChevronRight className="size-4 text-current" />
        </span>
      </SubTrigger>
      <SubContent className="min-w-48" data-testid={`${testId}-menu`}>
        <OpenInList target={target} editors={editors} parts={items} onPick={pick} testIdPrefix="open-in" />
      </SubContent>
    </Sub>
  );
}
