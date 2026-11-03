import { matchOffsets, type FindKey, type FindKind } from "@/lib/threadFind";
import { getTimeline } from "@/stores/cite";
import { getTurnView, putTurnView, setRowExpanded, type TurnView } from "@/stores/thread";
import { highlightsSupported, lineRects, paintAll, plainText, rangeOf, type PlainText } from "../cite/citeDom";
import { frame, scrollToQuote } from "../cite/reveal";

/**
 * The DOM side of the in-thread find (docs/notes/search-2-thread-find.md): the elements
 * whose text it searches, the ranges it paints (the cite layer's Custom Highlight API, or
 * its overlay where that is missing) and bringing a match into view, opening the fold or
 * row that hides it and putting them back afterwards.
 */

/** The attribute an element carries when its text is an item's searchable text (lib/threadFind findDoc): the item id. */
export const FIND_ITEM_ATTR = "data-find-item";

/** Inside a user bubble: the tags and the subagent prompt's label, which find leaves out. */
const FIND_SKIP = '[data-testid="thread-tag"], [data-testid="thread-user-label"]';

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

/** The fold and expand choices a reveal changed, with the values they had before (undefined: none). */
export interface Opened {
  folds: Record<string, boolean | undefined>;
  expanded: Record<string, boolean | undefined>;
}

function changed(before: Readonly<Record<string, boolean>>, after: Readonly<Record<string, boolean>>): Record<string, boolean | undefined> {
  const out: Record<string, boolean | undefined> = {};
  for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) if (before[k] !== after[k]) out[k] = before[k];
  return out;
}

function diff(before: TurnView, after: TurnView): Opened {
  return { folds: changed(before.folds, after.folds), expanded: changed(before.expanded, after.expanded) };
}

/** Puts back what a reveal opened. */
export function putBack(threadId: string, opened: Opened | null): void {
  if (opened) putTurnView(threadId, opened.folds, opened.expanded);
}

/**
 * Opens what hides an item for a match in it, after putting back what the last reveal
 * opened: a question's row expands (its detail holds the text) and the fold around it
 * opens (a thread's folded turn, Ember's work row; TimelineHandle.unfold). All in one tick
 * and from the store, not the rows on screen, so a choice both need is never toggled on
 * screen. Returns what it changed, to put back when the current match leaves the item or
 * the bar closes.
 */
export function openFor(threadId: string, itemId: string, kind: FindKind | undefined, last: Opened | null): Opened {
  putBack(threadId, last);
  const before = getTurnView(threadId);
  if (kind === "question") setRowExpanded(threadId, itemId, true);
  getTimeline(threadId)?.unfold?.(itemId);
  return diff(before, getTurnView(threadId));
}

/**
 * Brings a match into view: its row first (the list stops following the bottom), then,
 * once the row renders, the match's lines to the middle of the list's visible part
 * (cite/reveal scrollToQuote) unless they are in view. False when its row does not render.
 */
export async function revealMatch(threadId: string, pane: HTMLElement, key: FindKey, query: string, live: () => boolean): Promise<boolean> {
  const tl = getTimeline(threadId);
  if (!tl) return false;
  tl.unpin();
  // A row that renders already is placed by its match's lines below (a tall answer whose
  // match shows does not move); else the row is brought in first. The fold just opened
  // (openFor) renders on the next frames.
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
      const at = (r: Element) => {
        const pt = findText(r);
        const ms = matchOffsets(pt.text, query);
        const m = ms[key.nth] ?? ms[ms.length - 1];
        if (m) scrollToQuote(threadId, pane, pt, m);
      };
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
