import { matchOffsets, type FindKey } from "@/lib/threadFind";
import { getTimeline } from "@/stores/cite";
import { openThreadFindMessage } from "@/stores/threadFind";
import { highlightsSupported, lineRects, paintAll, plainText, rangeOf, type PlainText } from "../cite/citeDom";
import { frame, scrollToQuote } from "../cite/reveal";
import { foldHides } from "../foldDom";

/**
 * The DOM side of the in-thread find (docs/notes/search-2-thread-find.md): the elements
 * whose text it searches, the ranges it paints (the cite layer's Custom Highlight API, or
 * its overlay where that is missing) and bringing a match into view (what hides it is
 * opened and put back by the find's store: stores/threadFind openThreadFindItem).
 */

/** The attribute an element carries when its text is an item's searchable text (lib/threadFind findDoc): the item id. */
export const FIND_ITEM_ATTR = "data-find-item";

/**
 * Text find leaves out: inside a user bubble, the tags and the subagent prompt's label; in
 * an answer, an unloaded local image's chip (data-find-skip: the data counts no text for
 * an image).
 */
const FIND_SKIP = '[data-testid="thread-tag"], [data-testid="thread-user-label"], [data-find-skip]';

export function findItemSelector(itemId: string): string {
  return `[${FIND_ITEM_ATTR}="${CSS.escape(itemId)}"]`;
}

/** An item element's searchable text (the same text lib/threadFind reads from the item). */
export function findText(root: Element): PlainText {
  return plainText(root, FIND_SKIP);
}

/** The timeline's scrolling list in a thread body, where the rows render. */
export function timelineIn(pane: Element): HTMLElement | null {
  return pane.querySelector<HTMLElement>('[data-testid="thread-timeline"]');
}

/**
 * Paints every match rendered under `scope`: the current one solid, the rest tinted. The
 * DOM is matched again (the same smart-case substring), so a row that just mounted is
 * painted; rows that do not render are not. Returns the painted ranges by match (paintedKey).
 */
export function paintMatches(scope: Element | null, query: string, current: FindKey | null): Map<string, Range> {
  const painted = new Map<string, Range>();
  const all: Range[] = [];
  const cur: Range[] = [];
  const allRects: DOMRect[] = [];
  const curRects: DOMRect[] = [];
  const overlay = !highlightsSupported();
  if (scope && query !== "") {
    for (const root of Array.from(scope.querySelectorAll(`[${FIND_ITEM_ATTR}]`))) {
      const id = root.getAttribute(FIND_ITEM_ATTR) ?? "";
      const pt = findText(root);
      matchOffsets(pt.text, query).forEach((m, nth) => {
        const r = rangeOf(pt, m.start, m.end);
        if (!r) return;
        painted.set(`${id}\u0000${String(nth)}`, r);
        const isCurrent = current?.itemId === id && current.nth === nth;
        (isCurrent ? cur : all).push(r);
        if (overlay) (isCurrent ? curRects : allRects).push(...lineRects(pt, m.start, m.end));
      });
    }
  }
  paintAll("cf-find", all, allRects);
  paintAll("cf-find-current", cur, curRects);
  return painted;
}

/** A match's key in paintMatches' result. */
export function paintedKey(m: FindKey): string {
  return `${m.itemId}\u0000${String(m.nth)}`;
}

/** Clears the find's paint. */
export function clearMatches(): void {
  paintAll("cf-find", []);
  paintAll("cf-find-current", []);
}

/**
 * Brings a match into view: its row first (the list stops following the bottom), then,
 * once the row renders, the match's lines to the middle of the list's visible part
 * (cite/reveal scrollToQuote) unless they are in view. A long message whose fold hides the
 * match opens first; one whose match shows stays folded. False when its row does not render.
 */
export async function revealMatch(threadId: string, pane: HTMLElement, key: FindKey, query: string, live: () => boolean): Promise<boolean> {
  const tl = getTimeline(threadId);
  if (!tl) return false;
  tl.unpin();
  // A row that renders already is placed by its match's lines below (a tall answer whose
  // match shows does not move); else the row is brought in first. The fold just opened
  // (openThreadFindItem) renders on the next frames.
  if (!pane.querySelector(findItemSelector(key.itemId)) && !tl.showRow(key.itemId)) {
    await frame();
    await frame();
    if (!live() || !tl.showRow(key.itemId)) return false;
  }
  for (let i = 0; i < 60; i++) {
    if (!live()) return false;
    const root = pane.querySelector(findItemSelector(key.itemId));
    if (root) {
      // The virtualizer measures the rows it just mounted: settle, then place the match.
      await frame();
      if (!live()) return false;
      const matchIn = (r: Element) => {
        const pt = findText(r);
        const ms = matchOffsets(pt.text, query);
        const m = ms[key.nth] ?? ms[ms.length - 1];
        return m ? { pt, m } : null;
      };
      const at = (r: Element) => {
        const hit = matchIn(r);
        if (hit) scrollToQuote(threadId, pane, hit.pt, hit.m);
      };
      const hit = matchIn(pane.querySelector(findItemSelector(key.itemId)) ?? root);
      if (hit && foldHides(root, lineRects(hit.pt, hit.m.start, hit.m.end))) {
        openThreadFindMessage(threadId, key.itemId);
        await frame();
        await frame();
        if (!live()) return false;
      }
      at(pane.querySelector(findItemSelector(key.itemId)) ?? root);
      await frame();
      if (!live()) return false;
      at(pane.querySelector(findItemSelector(key.itemId)) ?? root);
      return true;
    }
    await frame();
  }
  return false;
}
