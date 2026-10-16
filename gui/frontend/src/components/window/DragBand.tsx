import { PANE_HEADER_HEIGHT } from "./titleBand";

/**
 * The drag surface of a pane that has no header (the start page, the new-thread
 * composer). It is the same strip a PaneHeader occupies (PANE_HEADER_HEIGHT), so it ends
 * on the title band's bottom edge (titleBand.ts) and the window drags from the same place
 * on every pane. Transparent and borderless: the page's centred content sits well below
 * it (the pages pad 40px), so it only ever covers padding. Place it in a `relative`
 * wrapper after the content, so it paints above the scrolling section.
 */
export function DragBand() {
  return <div className="absolute inset-x-0 top-0 z-10 [--wails-draggable:drag]" style={{ height: PANE_HEADER_HEIGHT }} data-testid="pane-drag-band" aria-hidden />;
}
