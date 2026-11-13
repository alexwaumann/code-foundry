/**
 * A pane's box (components/shell/PaneView.tsx) as what a surface inside it reaches for: popups
 * keep inside it (their collision boundary, components/pr/keys.ts usePanelBoundary), and a surface
 * part that closes (a pull request's Ask or Review composer) hands the keyboard back to it, so the
 * pane's keys (its surface's own, SurfaceSpec.onKey) keep working. One mark on every open pane,
 * whatever it shows: no surface marks its own box.
 */

/** The attribute an open pane's box carries. */
export const PANE_BOX_ATTR = "data-pane-box";

/** The open pane box around `el`, if any. */
export function paneBoxOf(el: Element | null | undefined): HTMLElement | null {
  return el?.closest<HTMLElement>(`[${PANE_BOX_ATTR}]`) ?? null;
}

/**
 * Moves the keyboard into a pane's body: its page's focus root ([data-focus-root]), else the body
 * itself, focusable only for this once (focusable for good, any press on a blank spot of a tab
 * would take the keyboard out of its prompt).
 */
export function focusPaneBody(body: HTMLElement): void {
  const root = body.querySelector<HTMLElement>("[data-focus-root]");
  if (root) {
    root.focus({ preventScroll: true });
    return;
  }
  body.tabIndex = -1;
  body.addEventListener(
    "blur",
    () => {
      body.removeAttribute("tabindex");
    },
    { once: true },
  );
  body.focus({ preventScroll: true });
}

/** Hands the keyboard back to the body of the pane around `el` (nothing outside a pane). */
export function focusPaneOf(el: Element | null | undefined): void {
  const body = paneBoxOf(el)?.querySelector<HTMLElement>(':scope > [role="tabpanel"]');
  if (body) focusPaneBody(body);
}
