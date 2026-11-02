import { useContext, useRef, useState, type ComponentType } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { NavContext } from "@/lib/nav";
import { MenuItems, type MenuParts, type OverflowItem } from "./OverflowMenu";
import { dismissFrom, RowMenuPickContext, type RowMenuEntry, type RowMenuPart, type RowMenuParts, type RowMenuPick } from "./rowMenu";

const CONTEXT_PARTS: MenuParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

/** The entries, built when the menu opens (Radix mounts the content only then); runs of text items go to MenuItems. */
function OpenItems<P extends RowMenuPart>({ items, parts, onPick }: { items: () => readonly RowMenuEntry<P>[]; parts: RowMenuParts<P>; onPick: (run: () => void) => void }) {
  let run: OverflowItem[] = [];
  const out: React.ReactNode[] = [];
  const flush = () => {
    if (run.length > 0) out.push(<MenuItems key={`items-${String(out.length)}`} items={run} parts={CONTEXT_PARTS} onPick={onPick} />);
    run = [];
  };
  for (const e of items()) {
    if (e === "separator" || !("kind" in e)) {
      run.push(e);
      continue;
    }
    flush();
    // Each kind's part takes that kind's entry (RowMenuParts); looked up by the entry's own kind.
    const Part = (parts as unknown as Readonly<Partial<Record<string, ComponentType<{ entry: P }>>>>)[e.kind];
    if (Part) out.push(<Part key={e.testId} entry={e} />);
  }
  flush();
  return out;
}

/**
 * A Projects page row's right-click menu (docs/notes/projects-table-2-context-menus.md): the row
 * (`children`, a NavRow) wrapped in the trigger. Opening it puts the list's cursor on the row; `items`
 * is read only while it is open. As in OverflowMenu, keys inside the menu stay there, and the picked
 * item runs after the menu has closed and given the keyboard back to the page's list (an item that
 * opens a dialog, the palette or an inline editor then keeps its focus). Entries with a `kind`
 * (submenus, a split item) are drawn by `parts` (docs/notes/project-page-2-checkouts.md).
 */
export function RowContextMenu<P extends RowMenuPart = never>({
  navKey,
  items,
  parts,
  testId,
  children,
}: {
  navKey: string;
  items: () => readonly RowMenuEntry<P>[];
  parts?: RowMenuParts<P>;
  testId: string;
  children: React.ReactNode;
}) {
  const { setCursor } = useContext(NavContext);
  const triggerRef = useRef<HTMLDivElement>(null);
  const picked = useRef<(() => void) | null>(null);
  const onPick = (run: () => void) => {
    picked.current = run;
  };
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
        <div ref={triggerRef} data-row-menu-trigger="">
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
          <OpenItems items={items} parts={parts ?? (NO_PARTS as RowMenuParts<P>)} onPick={onPick} />
        </RowMenuPickContext.Provider>
      </ContextMenuContent>
    </ContextMenu>
  );
}

const NO_PARTS = {};
