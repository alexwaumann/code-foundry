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
 * in the left half, left of it in the right half.
 */
export function tooltipStyle(index: number, n: number, x: number, width: number, top: number, gap = TOOLTIP_GAP): CSSProperties {
  return tooltipSide(index, n) === "left" ? { right: width - x + gap, top } : { left: x + gap, top };
}
