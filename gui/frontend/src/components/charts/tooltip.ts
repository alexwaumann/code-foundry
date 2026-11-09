/**
 * Where a chart's one tooltip goes (the Pull Requests activity charts, plugin bar charts):
 * beside the hovered point, on the side of the chart with more room.
 */
import type { CSSProperties } from "react";

/** Which side of point `index` of `n` the tooltip goes: the side of the card with more room. */
export function tooltipSide(index: number, n: number): "left" | "right" {
  return index >= n / 2 ? "left" : "right";
}

/** The tooltip's offset from its anchor's x (px). */
export const TOOLTIP_GAP = 14;

/**
 * The absolute position of a tooltip for point `index` of `n` anchored at `x` (px from the
 * plot's left edge) in a plot `width` px wide, `top` px from its top: right of the point
 * in the left half, left of it in the right half; with `fit`, no wider than the room there.
 */
export function tooltipStyle(index: number, n: number, x: number, width: number, top: number, gap = TOOLTIP_GAP, fit = false): CSSProperties {
  const left = tooltipSide(index, n) === "left";
  const at: CSSProperties = left ? { right: width - x + gap, top } : { left: x + gap, top };
  if (!fit) return at;
  // Never past the plot's edge (a narrow panel would scroll sideways): at most the room on
  // its side, less below the usual 160 px least width.
  const room = Math.max(0, Math.floor(left ? x - gap : width - x - gap));
  return { ...at, maxWidth: room, minWidth: Math.min(TOOLTIP_MIN_WIDTH, room) };
}

/** A tooltip's usual least width (min-w-40). */
export const TOOLTIP_MIN_WIDTH = 160;
