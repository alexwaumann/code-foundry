/**
 * Whether `el` has the keyboard inside an open modal that covers `root`: a dialog or alert
 * dialog that is open (Radix marks a closing one data-state="closed"), is not the command
 * palette (it hands the keyboard back as it closes) and does not hold `root` itself (a
 * composer inside a dialog is that dialog's own).
 *
 * A window-wide focus request (ui promptFocusSeq, contentFocusSeq) is not for a surface
 * under such a modal: the palette's close asks the content for the keyboard, and when the
 * command it ran opened a sheet first, the request would take the keyboard out of the sheet
 * and into the prompt behind it (docs/notes/sheet-keeps-keyboard.md).
 */
export function heldByModal(el: Element | null, root: Element | null): boolean {
  const modal = el?.closest('[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"]');
  if (!modal || modal.closest('[data-region="palette"]') !== null) return false;
  return root === null || !modal.contains(root);
}
