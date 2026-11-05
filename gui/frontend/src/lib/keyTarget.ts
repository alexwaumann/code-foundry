/** The element with the keyboard, inside any shadow roots: `document.activeElement` stops at the host. */
export function deepActiveElement(): Element | null {
  let at = document.activeElement;
  while (at?.shadowRoot?.activeElement) at = at.shadowRoot.activeElement;
  return at;
}

/**
 * The element a key event landed on. Inside a shadow root (the File tab's code editor, in
 * @pierre/diffs' shadow DOM) a listener outside it sees the host as `e.target`: only the
 * composed path tells a contenteditable or the editor's find field from the host.
 */
export function keyTarget(e: Event): Element | null {
  const first = e.composedPath()[0] ?? e.target;
  return first instanceof Element ? first : null;
}
