import { useContext, useRef } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { NavContext } from "@/lib/nav";
import { MenuItems, type MenuParts, type OverflowItem } from "./OverflowMenu";

const CONTEXT_PARTS: MenuParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

/** The items, built when the menu opens (Radix mounts the content only then). */
function OpenItems({ items, onPick }: { items: () => readonly OverflowItem[]; onPick: (run: () => void) => void }) {
  return <MenuItems items={items()} parts={CONTEXT_PARTS} onPick={onPick} />;
}

/**
 * A Projects index row's right-click menu (docs/notes/projects-table-2-context-menus.md): the row
 * (`children`, a NavRow) wrapped in the trigger. Opening it puts the list's cursor on the row; `items`
 * is read only while it is open. As in OverflowMenu, keys inside the menu stay there, and the picked
 * item runs after the menu has closed and given the keyboard back to the page's list (an item that
 * opens a dialog, the palette or an inline editor then keeps its focus).
 */
export function RowContextMenu({ navKey, items, testId, children }: { navKey: string; items: () => readonly OverflowItem[]; testId: string; children: React.ReactNode }) {
  const { setCursor } = useContext(NavContext);
  const triggerRef = useRef<HTMLDivElement>(null);
  const picked = useRef<(() => void) | null>(null);
  return (
    <ContextMenu
      modal={false}
      onOpenChange={(o) => {
        if (o) setCursor(navKey);
      }}
    >
      <ContextMenuTrigger asChild>
        <div ref={triggerRef}>{children}</div>
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
        <OpenItems
          items={items}
          onPick={(run) => {
            picked.current = run;
          }}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}
