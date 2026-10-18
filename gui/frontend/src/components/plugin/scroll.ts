/** A horizontal scroller's overflow cues (the view tabs: components/plugin/ViewTabsBar.tsx). */

/** Which ends of a scroller have more to show. */
export function overflowEdges(scrollLeft: number, clientWidth: number, scrollWidth: number): { start: boolean; end: boolean } {
  // A pixel of slack: zoom and subpixel layout leave fractions.
  return { start: scrollLeft > 1, end: scrollLeft + clientWidth < scrollWidth - 1 };
}

/** The edge fade on the sides with more tabs (a mask, so it works on any background). */
export function fadeMask(start: boolean, end: boolean): string | undefined {
  if (!start && !end) return undefined;
  const a = start ? "transparent 0, black 24px" : "black 0";
  const b = end ? "black calc(100% - 24px), transparent 100%" : "black 100%";
  return `linear-gradient(to right, ${a}, ${b})`;
}

/**
 * The scrollLeft that brings an item (its left edge and width inside the scroller's
 * content) fully into view clear of the edge fade (`margin`), moving as little as it can.
 */
export function scrollLeftToShow(scrollLeft: number, clientWidth: number, itemLeft: number, itemWidth: number, margin = 24): number {
  if (itemLeft - margin < scrollLeft) return Math.max(0, itemLeft - margin);
  if (itemLeft + itemWidth + margin > scrollLeft + clientWidth) return itemLeft + itemWidth + margin - clientWidth;
  return scrollLeft;
}
