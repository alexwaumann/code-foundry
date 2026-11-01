import type * as React from "react"

/**
 * A menu item's pointerleave while its menu animates out under a dialog does nothing.
 *
 * Radix focuses the menu's content when the pointer leaves an item. An item that opens a
 * dialog (Save as workspace, Snooze › Pick a date) puts the dialog's overlay under the pointer,
 * and the pointer then "leaves" the item while the menu is still fading out. Radix moves focus
 * from the dialog's field to the closing menu, which then unmounts and leaves focus on the body.
 * Calling preventDefault skips Radix's handler (composeEventHandlers checks it). Only with a
 * dialog up: a menu reopened during its fade (PrMenu after Ask) relies on that focus, so its
 * Escape closes the menu and not the composer the item opened.
 */
export function itemLeaveWhileClosing<E extends HTMLElement>(
  onPointerLeave?: React.PointerEventHandler<E>,
): React.PointerEventHandler<E> {
  return (e) => {
    onPointerLeave?.(e)
    const closing = e.currentTarget.closest('[role="menu"]')?.getAttribute("data-state") === "closed"
    if (closing && document.querySelector('[role="dialog"]')) e.preventDefault()
  }
}
