/**
 * Holding a timeline row's top in place while it resizes (docs/notes/page-library-fixes-b.md).
 * The timeline follows its bottom, so a page card that shrinks under the pointer (a filtered
 * list) slid down with it. While the pointer or focus is in the card's frame, the card's top
 * stays put instead: the scroll moves by however far the top went, and when the rows are now
 * too short for that (the card was at the bottom and shrank) a spacer under them makes up the
 * difference. Rows growing below take the spacer's place again (spacerAfterGrowth).
 */

/** The list's scroll box, its rows' own height (no spacer) apart: what heldScroll reads. */
export interface ScrollBox {
  scrollTop: number;
  /** The rows' height, without the spacer (it may be less than the box's). */
  contentHeight: number;
  clientHeight: number;
}

/** Where the list scrolls, and the spacer it needs, to put back a row whose top moved by `moved` px on screen (positive: down). */
export function heldScroll(box: ScrollBox, moved: number): { scrollTop: number; spacer: number } {
  const want = Math.max(0, box.scrollTop + moved);
  return { scrollTop: want, spacer: Math.max(0, Math.ceil(want - (box.contentHeight - box.clientHeight))) };
}

/** The spacer once the rows grew from `from` to `to` px: growth fills it, so the rows' end stays where it is on screen. */
export function spacerAfterGrowth(spacer: number, from: number, to: number): number {
  return Math.max(0, spacer - Math.max(0, to - from));
}
