import { createContext, useContext, useLayoutEffect, useState, type RefObject } from "react";
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

/**
 * The box fill nodes inside fill and the space they leave under it: a sized pane provides
 * itself, the surface's frame its scroll area (box null until mounted: fill nodes wait).
 * Not provided (undefined: a node drawn outside a surface), fillBoxOf finds it in the DOM.
 * A context rather than a DOM lookup, so a node follows an enclosing pane that becomes or
 * stops being a box under the same key.
 */
export interface FillBox {
  box: HTMLElement | null;
  bottom: number;
}

export const FillBoxContext = createContext<FillBox | undefined>(undefined);

/** The box a fill node at `el` fills, and the space it leaves under it: the nearest fill box around el, else the scroll area. */
export function fillBoxOf(el: HTMLElement): { box: HTMLElement; bottom: number } | null {
  const box = el.parentElement?.closest<HTMLElement>(`[${FILL_BOX_ATTR}], [data-scroll-root]`) ?? null;
  if (!box) return null;
  return { box, bottom: box.hasAttribute(FILL_BOX_ATTR) ? 0 : FILL_BOTTOM };
}

/**
 * The CSS height of a thread, terminal or pane node: pixels as given, `auto` for "auto"
 * (absent), and for "fill" the rest of its box (FillBoxContext, fillHeight) at least
 * `floor`, measured on the node and followed as the box resizes and as anything in the box
 * changes: what is above the node moves it without resizing the box (a section folding,
 * text growing, columns going side by side), so any change in the box outside the node
 * itself re-measures (a MutationObserver; its callback runs before the next paint).
 */
export function useNodeHeight<A extends number | undefined>(ref: RefObject<HTMLElement | null>, height: NodeHeight | undefined, auto: A, floor = FILL_MIN): number | A {
  const fill = height === "fill";
  const provided = useContext(FillBoxContext);
  const [filled, setFilled] = useState(floor);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!fill || !el) return;
    const at = provided === undefined ? fillBoxOf(el) : provided;
    const box = at?.box;
    if (!at || !box) return;
    const measure = () => {
      const top = el.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - box.clientTop;
      setFilled(fillHeight(box.clientHeight, top, floor, at.bottom));
    };
    measure();
    // The box's resize comes before the re-render it causes (columns going side by side on
    // their own observer): measure again in the next frame too.
    let frame = 0;
    const ro = new ResizeObserver(() => {
      measure();
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    });
    ro.observe(box);
    const mo =
      typeof MutationObserver === "undefined"
        ? null
        : new MutationObserver((records) => {
            // Changes inside the node (a thread streaming) do not move it.
            if (records.some((r) => !el.contains(r.target))) measure();
          });
    mo?.observe(box, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["class", "style"] });
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      mo?.disconnect();
    };
  }, [ref, fill, floor, provided]);
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
