import { CITE_EDGE, locateQuote, type CitationBody } from "@/lib/citation";
import { getTimeline } from "@/stores/cite";
import { useThreadStore } from "@/stores/thread";
import { citeItemSelector, lineRects, plainText, type PlainText } from "./citeDom";

/** The next animation frame. */
export function frame(): Promise<void> {
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

/** The top of the composer (or the agents strip on it) in a thread body: what the timeline's visible part ends at. */
export function dockTop(pane: HTMLElement): number {
  const dock = pane.querySelector(".dock");
  const tops = dock ? Array.from(dock.children, (c) => c.getBoundingClientRect()).filter((r) => r.height > 0).map((r) => r.top) : [];
  return tops.length > 0 ? Math.min(...tops) : pane.getBoundingClientRect().bottom;
}

/** Whether an item is one of the thread's items (Go to source needs it on screen). */
export function hasItem(threadId: string, itemId: string): boolean {
  return useThreadStore.getState().logs[threadId]?.byId[itemId] !== undefined;
}

/** Scrolls the timeline so the quote's lines sit in the middle of its visible part (top-aligned when taller), unless they are in view. */
function scrollToQuote(threadId: string, pane: HTMLElement, pt: PlainText, at: { start: number; end: number }): void {
  const tl = getTimeline(threadId);
  const rects = lineRects(pt, at.start, at.end);
  const first = rects[0];
  const last = rects[rects.length - 1];
  if (!tl || !first || !last) return;
  const top = tl.scroller.getBoundingClientRect().top + CITE_EDGE;
  const bottom = dockTop(pane) - CITE_EDGE;
  if (first.top >= top && last.bottom <= bottom) return;
  const height = last.bottom - first.top;
  const want = height > bottom - top ? top : top + (bottom - top - height) / 2;
  tl.unpin();
  tl.scroller.scrollTop += first.top - want;
}

/**
 * Brings a citation's quote into view in the timeline: in Ember's chat, opens the work row
 * its text folded into (a thread's folded turn still shows every text), scrolls the row
 * in, waits for it to render, finds the quote (lib/citation locateQuote) and scrolls it to
 * the middle. Resolves with
 * the quote's offsets in the answer's plain text, or null when the answer is not in
 * this thread, its row does not render, or the quote is no longer in it.
 */
export async function revealQuote(threadId: string, pane: HTMLElement, cite: CitationBody): Promise<{ start: number; end: number } | null> {
  if (!hasItem(threadId, cite.itemId)) return null;
  const tl = getTimeline(threadId);
  if (!tl) return null;
  // A thread's fold never hides Claude's text (docs/notes/thread-fold-5-text-and-html.md);
  // only Ember's chat folds a turn's earlier texts into a work row, which `unfold` opens.
  if (!tl.showRow(cite.itemId)) {
    if (!tl.unfold?.(cite.itemId)) return null;
    await frame();
    await frame();
    if (!tl.showRow(cite.itemId)) return null;
  }
  for (let i = 0; i < 60; i++) {
    const root = pane.querySelector(citeItemSelector(cite.itemId));
    if (root) {
      // The virtualizer measures the rows it just mounted: settle, then place the quote.
      await frame();
      const pt = plainText(root);
      const at = locateQuote(pt.text, cite);
      if (!at) return null;
      scrollToQuote(threadId, pane, pt, at);
      await frame();
      scrollToQuote(threadId, pane, plainText(pane.querySelector(citeItemSelector(cite.itemId)) ?? root), at);
      return at;
    }
    await frame();
  }
  return null;
}
