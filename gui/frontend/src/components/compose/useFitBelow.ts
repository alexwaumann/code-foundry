import { useLayoutEffect, type RefObject } from "react";
import { zoomFactor } from "@/lib/zoom";
import { useUiStore } from "@/stores/ui";

/** Layout px kept free between the card and the bottom of the visible area. */
const BOTTOM_MARGIN = 16;
/** A row's height (h-7) and the list's vertical padding (py-1), in layout px. */
const ROW = 28;
const LIST_PADDING = 8;
/** The list's own cap (max-h-[15.5rem]): about eight rows. */
const LIST_MAX = 248;
/** One row plus the list's padding and the card's border: the card never gets shorter. */
const MIN_HEIGHT = ROW + LIST_PADDING + 2;
/** Below this the hints footer hides, leaving the space to the rows (two rows and the footer). */
const HINTS_MIN_HEIGHT = 2 * ROW + LIST_PADDING + 2 + 29;

/** The nearest ancestor that scrolls vertically (the composer's section), or null. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

/**
 * Caps the card's height to the space between its top and the bottom of the visible area
 * (the scroller's box, the window), less a margin, and when that is less than the list's
 * own cap, the list to whole rows (no row cut by the hints). Rects are viewport px;
 * max-heights and offsetHeight are layout px, so the distance is divided by the page zoom.
 */
function fit(el: HTMLElement, scroller: HTMLElement | null, above: boolean): void {
  const r = el.getBoundingClientRect();
  // Above its anchor (a thread's composer at the pane's bottom), the room runs
  // from the top of the visible area down to the card's bottom.
  const top = above ? Math.max(0, scroller ? scroller.getBoundingClientRect().top : 0) : r.top;
  const bottom = above ? r.bottom : Math.min(window.innerHeight, scroller ? scroller.getBoundingClientRect().bottom : Infinity);
  const space = Math.max(Math.floor((bottom - top) / zoomFactor()) - BOTTOM_MARGIN, MIN_HEIGHT);
  el.toggleAttribute("data-short", space < HINTS_MIN_HEIGHT);
  el.style.maxHeight = `${String(space)}px`;
  const list = el.querySelector<HTMLElement>('[role="listbox"]');
  if (!list) return;
  // The list's room: the space less the card's other parts (hints, border).
  const room = space - (el.offsetHeight - list.offsetHeight);
  const rows = Math.max(1, Math.floor((room - LIST_PADDING) / ROW));
  list.style.maxHeight = room >= LIST_MAX ? "" : `${String(rows * ROW + LIST_PADDING)}px`;
}

/**
 * Refits an open card overlaid on the composer (the completion card, the previous prompts
 * card: rows h-7 in a `listbox`) whenever the space for it or its content can change: the
 * window resizes, the zoom changes, the scroller scrolls, the card changes size (rows
 * come and go), or any ancestor up to the scroller changes size (a growing prompt moves
 * the centered composer, and the card with it).
 */
export function useFitBelow(ref: RefObject<HTMLDivElement | null>, open: boolean, above: boolean): void {
  const zoom = useUiStore((s) => s.zoom);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const scroller = scrollerOf(el);
    const refit = () => {
      fit(el, scroller, above);
    };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    for (let p = el.parentElement; p; p = p.parentElement) {
      observer.observe(p);
      if (p === scroller) break;
    }
    window.addEventListener("resize", refit);
    scroller?.addEventListener("scroll", refit, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", refit);
      scroller?.removeEventListener("scroll", refit);
    };
  }, [ref, open, zoom, above]);
}
