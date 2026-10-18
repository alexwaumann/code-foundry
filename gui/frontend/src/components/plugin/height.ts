import { useLayoutEffect, useState, type RefObject } from "react";
import type { NodeHeight } from "@/api/plugin";

/** "fill" never goes below this, however little of the panel is left. */
export const FILL_MIN = 240;
/** The space "fill" leaves under the node (the surface's bottom padding). */
const FILL_BOTTOM = 16;

/**
 * A fill node's height: the rest of its scroll box's (the side panel's data-scroll-root)
 * height below the node's top, at least FILL_MIN, followed as the panel resizes.
 */
export function fillHeight(boxHeight: number, nodeTop: number): number {
  return Math.max(FILL_MIN, Math.round(boxHeight - nodeTop - FILL_BOTTOM));
}

/**
 * The CSS height of a thread or terminal node: pixels as given, `auto` for "auto" (absent),
 * and for "fill" the rest of the panel (fillHeight), measured on the node.
 */
export function useNodeHeight(ref: RefObject<HTMLElement | null>, height: NodeHeight | undefined, auto: number): number {
  const fill = height === "fill";
  const [filled, setFilled] = useState(FILL_MIN);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!fill || !el) return;
    const box = el.closest<HTMLElement>("[data-scroll-root]");
    if (!box) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
      setFilled(fillHeight(box.clientHeight, top));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => {
      ro.disconnect();
    };
  }, [ref, fill]);
  if (typeof height === "number") return height;
  return fill ? filled : auto;
}

/** Default rows of an "auto" terminal node. */
const DEFAULT_ROWS = 16;
/** Pixels per text row (the terminal's line height at 13 px) and the host's padding. */
const ROW_PX = 17;
const PAD_PX = 8;

/** An "auto" terminal node's height for its rows (4..60, default 16) at the font size. */
export function terminalAutoHeight(rows: number | undefined, fontSize: number): number {
  const r = rows !== undefined && rows >= 4 && rows <= 60 ? rows : DEFAULT_ROWS;
  return Math.round(r * ROW_PX * (fontSize / 13)) + PAD_PX;
}

/**
 * Whether the element is narrower than `px` (followed as it resizes): a node's own width
 * decides when its title bar drops button labels. False until measured.
 */
export function useNarrowerThan(el: HTMLElement | null, px: number): boolean {
  const [narrow, setNarrow] = useState(false);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width;
      if (w > 0) setNarrow(w < px);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [el, px]);
  return narrow;
}
