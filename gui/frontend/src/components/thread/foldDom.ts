import { zoomFactor } from "@/lib/zoom";

/** How far above the fold's edge a long message starts to fade (MessageFold's mask): text in it is not there to read. */
export const FOLD_FADE_PX = 64;

/** The attribute on a long message's fold box while it is folded. */
export const FOLDED_ATTR = "data-message-folded";

/**
 * Whether a long message's fold hides any of `rects`, lines of the text under `root`: they
 * end below the fade's start. Clipped text keeps its boxes, so this holds for a line far
 * below the fold. False when `root` is not in a folded message.
 */
export function foldHides(root: Element, rects: readonly DOMRect[]): boolean {
  const box = root.closest(`[${FOLDED_ATTR}]`);
  if (!box) return false;
  // Rects are in zoomed px (lib/zoom), the fade in CSS px.
  const edge = box.getBoundingClientRect().bottom - FOLD_FADE_PX * zoomFactor();
  return rects.some((r) => r.bottom > edge);
}
