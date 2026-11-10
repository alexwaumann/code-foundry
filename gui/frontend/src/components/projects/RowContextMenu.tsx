import { useContext, useRef, useState } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { NavContext } from "@/lib/nav";
import { MenuEntries, type MenuParts } from "./OverflowMenu";
import { dismissFrom, RowMenuPickContext, type RowMenuEntry, type RowMenuPart, type RowMenuParts, type RowMenuPick } from "./rowMenu";

const CONTEXT_PARTS: MenuParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

/** The entries, built when the menu opens (Radix mounts the content only then). */
function OpenItems<P extends RowMenuPart>({ items, parts, onPick }: { items: () => readonly RowMenuEntry<P>[]; parts: RowMenuParts<P>; onPick: (run: () => void) => void }) {
  return <MenuEntries entries={items()} parts={parts} menu={CONTEXT_PARTS} onPick={onPick} />;
}

/**
 * A Projects page row's right-click menu (docs/notes/projects-table-2-context-menus.md): the row
 * (`children`, a NavRow) wrapped in the trigger. Opening it puts the list's cursor on the row; `items`
 * is read only while it is open. As in OverflowMenu, keys inside the menu stay there, and the picked
 * item runs after the menu has closed and given the keyboard back to the page's list (an item that
 * opens a dialog, the palette or an inline editor then keeps its focus). Entries with a `kind`
 * (submenus, a split item) are drawn by `parts` (docs/notes/project-page-2-checkouts.md).
 * `className` styles the trigger's wrapper (a subgrid level in a table whose rows share columns).
 */
export function RowContextMenu<P extends RowMenuPart = never>({
  navKey,
  items,
  parts,
  testId,
  className,
  children,
}: {
  navKey: string;
  items: () => readonly RowMenuEntry<P>[];
  parts?: RowMenuParts<P>;
  testId: string;
  className?: string;
  children: React.ReactNode;
}) {
  const { setCursor } = useContext(NavContext);
  const triggerRef = useRef<HTMLDivElement>(null);
  const picked = useRef<(() => void) | null>(null);
  const [pick] = useState<RowMenuPick>(() => ({
    pick: (run) => {
      picked.current = run;
    },
    close: (run, from) => {
      picked.current = run;
      dismissFrom(from);
    },
  }));
  return (
    <ContextMenu
      modal={false}
      onOpenChange={(o) => {
        if (o) setCursor(navKey);
      }}
    >
      <ContextMenuTrigger asChild>
        <div ref={triggerRef} data-row-menu-trigger="" className={className}>
          {children}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent
        className="min-w-[200px]"
        data-testid={testId}
        onKeyDown={(e) => {
          e.stopPropagation();
        }}
        onClick={(e) => {
          // Portal events still bubble through React: not to the row (activation).
          e.stopPropagation();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          const active = document.activeElement;
          if (!active || active === document.body) triggerRef.current?.closest<HTMLElement>("[data-focus-root]")?.focus({ preventScroll: true });
          const run = picked.current;
          picked.current = null;
          run?.();
        }}
      >
        <RowMenuPickContext.Provider value={pick}>
          <OpenItems items={items} parts={parts ?? (NO_PARTS as RowMenuParts<P>)} onPick={pick.pick} />
        </RowMenuPickContext.Provider>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const NO_PARTS = {};
