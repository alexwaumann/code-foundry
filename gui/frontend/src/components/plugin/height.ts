import { useLayoutEffect, useState, type RefObject } from "react";
import type { NodeHeight } from "@/api/plugin";

/** "fill" never goes below this (unless a fill pane's minHeight says less), however little of its box is left. */
export const FILL_MIN = 240;
/** The space "fill" leaves under the node in the surface's scroll area (its bottom padding); a pane has none. */
export const FILL_BOTTOM = 16;

/**
 * Marks a fill box: a pane with a px or fill height (PaneNode). A fill node fills the
 * nearest one around it, else the surface's scroll area ([data-scroll-root]).
 */
export const FILL_BOX_ATTR = "data-fill-box";

/**
 * A fill node's height: the rest of its box's height below the node's top, less the
 * box's bottom space, at least `floor`.
 */
export function fillHeight(boxHeight: number, nodeTop: number, floor = FILL_MIN, bottom = FILL_BOTTOM): number {
  return Math.max(floor, Math.floor(boxHeight - nodeTop - bottom));
}

/** The box a fill node at `el` fills, and the space it leaves under it: the nearest fill box around el, else the scroll area. */
export function fillBoxOf(el: HTMLElement): { box: HTMLElement; bottom: number } | null {
  const box = el.parentElement?.closest<HTMLElement>(`[${FILL_BOX_ATTR}], [data-scroll-root]`) ?? null;
  if (!box) return null;
  return { box, bottom: box.hasAttribute(FILL_BOX_ATTR) ? 0 : FILL_BOTTOM };
}

/**
 * The CSS height of a thread, terminal or pane node: pixels as given, `auto` for "auto"
 * (absent), and for "fill" the rest of its box (fillBoxOf, fillHeight) at least `floor`,
 * measured on the node and followed as the box resizes.
 */
export function useNodeHeight<A extends number | undefined>(ref: RefObject<HTMLElement | null>, height: NodeHeight | undefined, auto: A, floor = FILL_MIN): number | A {
  const fill = height === "fill";
  const [filled, setFilled] = useState(floor);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!fill || !el) return;
    const at = fillBoxOf(el);
    if (!at) return;
    const { box, bottom } = at;
    const measure = () => {
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - box.clientTop;
      setFilled(fillHeight(box.clientHeight, top, floor, bottom));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(box);
    return () => {
      ro.disconnect();
    };
  }, [ref, fill, floor]);
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
