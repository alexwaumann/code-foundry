import { createContext, type ComponentType, type KeyboardEvent } from "react";
import type { OverflowItem } from "./OverflowMenu";

/* What a Projects page row's right-click menu (RowContextMenu.tsx) and its parts share. */

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

/**
 * Closes a Radix menu from inside it without a Radix item: its dismissable layer listens for
 * Escape on the document (capture), and the content's own key handler keeps the key from the
 * page. A submenu still open would take it instead: the split item closes its own first.
 */
export function dismissFrom(el: HTMLElement): void {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
}

/**
 * The keyboard's way to a row's right-click menu: the ContextMenu key or Shift+F10 on a page's
 * list opens the menu of the row under its cursor, at the row's start, as a right-click there
 * would (Radix opens a context menu on the contextmenu event). True when it handled the key.
 */
export function openCursorRowMenu(e: KeyboardEvent<HTMLElement>): boolean {
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
