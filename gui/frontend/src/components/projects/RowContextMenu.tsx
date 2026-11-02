import { createContext, useContext, useRef, type ComponentType } from "react";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "@/components/ui/context-menu";
import { NavContext } from "@/lib/nav";
import { MenuItems, type MenuParts, type OverflowItem } from "./OverflowMenu";

const CONTEXT_PARTS: MenuParts = { Item: ContextMenuItem, Separator: ContextMenuSeparator };

/**
 * A richer entry of a row's right-click menu than a text item, named by `kind` and drawn by
 * the part registered for it (`parts`): a checkout's Open thread and Run action submenus and
 * its split Open in Finder item (CheckoutMenuParts.tsx). The menus that use them list their
 * parts, so this file knows none of them.
 */
export interface RowMenuPart {
  kind: string;
  testId: string;
}

/** One entry of a row's right-click menu: a text item, a separator, or a part. */
export type RowMenuEntry<P extends RowMenuPart = never> = OverflowItem | P;

/** The component drawing each kind of part, given its entry. */
export type RowMenuParts<P extends RowMenuPart> = { readonly [K in P["kind"]]: ComponentType<{ entry: Extract<P, { kind: K }> }> };

/**
 * How a part's item runs what it does: `pick` records it, to run once the menu has closed
 * (an item Radix selects closes the menu itself); `close` closes the menu from an element
 * that is not a Radix item (a split item's own half), then runs it.
 */
export interface RowMenuPick {
  pick: (run: () => void) => void;
  close: (run: () => void, from: HTMLElement) => void;
}

export const RowMenuPickContext = createContext<RowMenuPick>({ pick: () => undefined, close: () => undefined });

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
 * Closes a Radix menu from inside it without a Radix item: its dismissable layer listens for
 * Escape on the document (capture), and the content's own key handler keeps the key from the
 * page. A submenu still open would take it instead: the split item closes its own first.
 */
function dismissFrom(el: HTMLElement): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
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
  const pick = useRef<RowMenuPick>({
    pick: onPick,
    close: (run, from) => {
      picked.current = run;
      dismissFrom(from);
    },
  }).current;
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

/**
 * The keyboard's way to a row's right-click menu: the ContextMenu key or Shift+F10 on a page's
 * list opens the menu of the row under its cursor, at the row's start, as a right-click there
 * would (Radix opens a context menu on the contextmenu event). True when it handled the key.
 */
export function openCursorRowMenu(e: React.KeyboardEvent<HTMLElement>): boolean {
  if (e.metaKey || e.ctrlKey || e.altKey) return false;
  if (e.key !== "ContextMenu" && !(e.key === "F10" && e.shiftKey)) return false;
  const row = e.currentTarget.querySelector<HTMLElement>('[role="option"][aria-selected="true"]');
  const trigger = row?.closest<HTMLElement>("[data-row-menu-trigger]");
  e.preventDefault();
  if (!row || !trigger) return true;
  const r = row.getBoundingClientRect();
  trigger.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: r.left + 24, clientY: r.bottom }));
  return true;
}
