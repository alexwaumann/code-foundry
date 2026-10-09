/** Scrolls the strip (only the strip) so the tab is fully visible, with a small margin. */
export function revealTab(strip: HTMLElement, id: string): void {
  const el = Array.from(strip.querySelectorAll<HTMLElement>("[data-tab-id]")).find((t) => t.dataset.tabId === id);
  if (!el) return;
  const pad = 6;
  const left = el.offsetLeft;
  const right = left + el.offsetWidth;
  if (left - pad < strip.scrollLeft) strip.scrollLeft = Math.max(0, left - pad);
  else if (right + pad > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right + pad - strip.clientWidth;
}
