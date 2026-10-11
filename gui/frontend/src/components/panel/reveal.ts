/** The strip's element for a tab (its wrapper, with `data-tab-id`), or null. */
export function tabNode(strip: HTMLElement, id: string): HTMLElement | null {
  return Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]")).find((t) => t.dataset.tabId === id) ?? null;
}

/** Scrolls the strip (only the strip) so the tab is fully visible, with a small margin. */
export function revealTab(strip: HTMLElement, id: string): void {
  const el = tabNode(strip, id);
  if (el) revealElement(strip, el);
}

/** Scrolls the strip (only the strip) so one of its children (a tab, the "+") is fully visible, with a small margin. */
export function revealElement(strip: HTMLElement, el: HTMLElement): void {
  const pad = 6;
  const left = el.offsetLeft;
  const right = left + el.offsetWidth;
  if (left - pad < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - pad);
  else if (right + pad > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right + pad - strip.clientWidth;
}
