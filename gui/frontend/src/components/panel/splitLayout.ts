/**
 * How a split side panel lays out its two tab groups (docs/notes/panel-split-2-gui.md).
 * The orientation is never stored: it follows the panel's rendered width. The stored
 * ratio (stores/panel.ts) is the share of the split's axis the first group takes,
 * whichever axis that is.
 */
import { RATIO_DEFAULT, RATIO_MAX, RATIO_MIN } from "@/stores/panel";
import { PANEL_GROUP_MIN_HEIGHT, PANEL_MIN, PANEL_SIDE_BY_SIDE_MIN } from "@/stores/ui";

/** Side by side (groups left and right, a vertical divider) or stacked (top and bottom, a horizontal one). */
export type SplitOrientation = "side" | "stack";

/** The divider between the groups is a 1px line. */
export const DIVIDER = 1;

/**
 * The orientation for a panel rendered `width` px wide: side by side from
 * PANEL_SIDE_BY_SIDE_MIN (room for two PANEL_GROUP_SIDE_MIN groups), stacked below it.
 * An expanded panel follows its rendered width too (stores/ui.ts expandedPanelWidth), so
 * a narrow window stacks it rather than clipping the second group.
 */
export function splitOrientation(width: number): SplitOrientation {
  return width >= PANEL_SIDE_BY_SIDE_MIN ? "side" : "stack";
}

/** The least a group gets on the split's axis: PANEL_MIN wide side by side, PANEL_GROUP_MIN_HEIGHT tall stacked. */
export function groupMin(o: SplitOrientation): number {
  return o === "side" ? PANEL_MIN : PANEL_GROUP_MIN_HEIGHT;
}

/**
 * The ratios a split `size` px long (the divider excluded) can show: each group at least
 * `min` px, within the store's RATIO_MIN..RATIO_MAX. When even that does not fit (a
 * stacked panel in a short window), only RATIO_DEFAULT.
 */
export function ratioBounds(size: number, min: number): { lo: number; hi: number } {
  if (!(size > 0)) return { lo: RATIO_DEFAULT, hi: RATIO_DEFAULT };
  const lo = Math.max(RATIO_MIN, min / size);
  const hi = Math.min(RATIO_MAX, 1 - min / size);
  return lo > hi ? { lo: RATIO_DEFAULT, hi: RATIO_DEFAULT } : { lo, hi };
}

/** A ratio clamped to ratioBounds and rounded to three places (what the divider stores). */
export function clampSplitRatio(ratio: number, size: number, min: number): number {
  const { lo, hi } = ratioBounds(size, min);
  return Math.round(Math.max(lo, Math.min(hi, ratio)) * 1000) / 1000;
}

/** Arrow-key step of the divider, in px; with Shift, four times that (like the panel's resize handle). */
export const DIVIDER_STEP = 16;

/**
 * Where a key on the divider moves the ratio of a split `size` px long, or null for a
 * key it ignores. Left or Up moves the divider towards the first group, Right or Down
 * away from it (both pairs work in either orientation), by DIVIDER_STEP px (Shift: four
 * times that). Home and End go to the bounds. Clamped like a drag.
 */
export function dividerKeyRatio(key: string, shift: boolean, ratio: number, size: number, min: number): number | null {
  const { lo, hi } = ratioBounds(size, min);
  const step = size > 0 ? ((shift ? 4 : 1) * DIVIDER_STEP) / size : 0;
  const next =
    key === "ArrowLeft" || key === "ArrowUp" ? ratio - step : key === "ArrowRight" || key === "ArrowDown" ? ratio + step : key === "Home" ? lo : key === "End" ? hi : null;
  return next === null ? null : clampSplitRatio(next, size, min);
}
