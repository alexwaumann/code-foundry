/**
 * A table cell's meter (pluginsdk/ui Meter; docs/notes/plugin-table-meter.md): how wide its
 * fill is, its colour per tone, and whether its label fits beside the track. Pure:
 * nodes/MeterCell.tsx draws it.
 */
import type { Tone } from "@/api/plugin";
import type { TableMeter } from "@/api/pluginTable";

/**
 * The label's slot after the track (px): wide enough for a short label in the caption role
 * with tabular figures ("100%" 33 px, "3 of 8" 38 px in WebKit), and the same in every row
 * so a column's tracks line up. A longer label is cut, whole in its tooltip.
 */
export const METER_LABEL_PX = 40;
/** The gap between the track and the label (gap-2). */
export const METER_GAP_PX = 8;
/** The least track worth keeping beside a label (px): under it the label goes, so the bar keeps its length. */
export const METER_MIN_TRACK_PX = 48;
/** The narrowest cell that shows the label: the least track, the gap and the slot. */
export const METER_LABEL_MIN_CELL_PX = METER_MIN_TRACK_PX + METER_GAP_PX + METER_LABEL_PX;
/** The least fill of a value above 0 (px), so a sliver still shows. */
export const METER_MIN_FILL_PX = 2;

/** A value as the fill's fraction: 0..1 (the daemon refuses others; anything else draws as 0 or full). */
export function meterFraction(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(1, value);
}

/** The fill's width and least width: a percentage of the track, at least METER_MIN_FILL_PX above 0, none at 0. */
export function meterFill(value: number): { width: string; minWidth: number } {
  const f = meterFraction(value);
  return { width: `${String(f * 100)}%`, minWidth: f > 0 ? METER_MIN_FILL_PX : 0 };
}

/** aria-valuenow: the value as a whole percentage, 0..100. */
export function meterPercent(value: number): number {
  return Math.round(meterFraction(value) * 100);
}

/** Whether the label shows in a cell `width` px wide (null before it is measured: shown); a meter without a label has none to show. */
export function meterShowsLabel(meter: TableMeter, width: number | null): boolean {
  if (!meter.label) return false;
  return width === null || width >= METER_LABEL_MIN_CELL_PX;
}

/** The fill's colour per tone: the stats' and bars' status colours; neutral is the text colour at 55 %. */
const METER_FILL: Readonly<Record<Tone, string>> = {
  "": "bg-cf-text/55",
  muted: "bg-cf-text-muted",
  attention: "bg-cf-warning",
  error: "bg-cf-error",
  ok: "bg-cf-success",
};

/** A fill's tone class; an unknown tone (a newer plugin) or "neutral" is neutral. */
export function meterFillClass(tone: string | undefined): string {
  return (METER_FILL as Record<string, string | undefined>)[tone ?? ""] ?? METER_FILL[""];
}
