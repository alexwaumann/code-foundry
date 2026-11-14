/**
 * Layout and colour decisions of the stats and bars nodes (docs/notes/plugin-stats-bars.md),
 * kept pure so the unit tests pin them: how many cards a row holds and which type role the
 * figures take at a width, a figure's tone, a bar's geometry, height and paint, and the
 * keys that move the highlighted bar.
 */
import type { CSSProperties } from "react";
import type { Status, Tone } from "@/api/plugin";
import type { Bar, BarsData } from "@/api/pluginCharts";
import { slotColorVars, type ModelSlot } from "@/lib/usage";

// ---- Stats ---------------------------------------------------------------------

/** pluginsdk/ui StatCardMinWidth: a card never gets narrower; the row wraps instead. */
const STAT_CARD_MIN_WIDTH = 100;
/** The gap between cards, both ways (the Pull Requests cards' gap-3). */
const STAT_GAP = 12;
/** A card's horizontal padding and border (px-3.5, 1 px each side). */
const STAT_CARD_INSET = 2 * 14 + 2;

/**
 * How many cards a row of `n` holds in `width` px: all of them when they fit at
 * STAT_CARD_MIN_WIDTH each, else the fewest balanced rows (four cards: two by two; five:
 * three and two), at least one card a row. Before the first measure (null) one row.
 */
export function statsColumns(width: number | null, n: number): number {
  const count = Math.max(1, n);
  if (width === null) return count;
  for (let rows = 1; rows <= count; rows++) {
    const cols = Math.ceil(count / rows);
    if (cols * STAT_CARD_MIN_WIDTH + (cols - 1) * STAT_GAP <= width) return cols;
  }
  return 1;
}

/** The figure roles, largest first, with their font size (px; index.css). */
const FIGURE_ROLES = [
  { role: "text-display-sm", px: 32 },
  { role: "text-title", px: 22 },
  { role: "text-heading", px: 15 },
] as const;
export type FigureRole = (typeof FIGURE_ROLES)[number]["role"];

/**
 * Advance widths (em) of the semibold UI font at the figure roles, by character class,
 * measured in WebKit ("4m 12s" is 3.15 em at title, 3.37 at display, 3.43 at heading);
 * figureRole adds FIGURE_MARGIN on top.
 */
function charEm(ch: string): number {
  if (/[0-9]/.test(ch)) return 0.56; // tabular figures
  if (ch === " ") return 0.25;
  if (/[.,:;'!|ilj]/.test(ch)) return 0.3;
  if (/[%@]/.test(ch)) return 0.95;
  if (/[mwMW]/.test(ch)) return 0.85;
  if (/[A-Z]/.test(ch)) return 0.7;
  return 0.55;
}

/** Headroom on the estimate, so a figure that is estimated to fit never wraps. */
const FIGURE_MARGIN = 1.08;

/** An estimate of `text`'s width in em at a semibold figure role. */
export function figureEm(text: string): number {
  let em = 0;
  for (const ch of text) em += charEm(ch);
  return em;
}

/**
 * The least width of a stats node whose figures may take the display role: the row is
 * then a page's (or an expanded panel's) headline figures, as the Pull Requests page's
 * counts are; in a narrow pane (about 360 px) they are title at most.
 */
export const STATS_DISPLAY_WIDTH = 560;

/**
 * The type role of a stats node `width` px wide whose cards are `cardWidth` px: the
 * largest whose estimated width of the widest value fits a card (its padding off), so
 * "4m 12s" never wraps; one role for the whole row. Display only from STATS_DISPLAY_WIDTH,
 * heading when even title does not fit (the value is then cut with "…" as a last resort).
 */
export function figureRole(width: number, cardWidth: number, values: readonly string[]): FigureRole {
  const inner = cardWidth - STAT_CARD_INSET;
  const em = Math.max(0, ...values.map(figureEm));
  for (const r of FIGURE_ROLES) {
    if (r.role === "text-display-sm" && width < STATS_DISPLAY_WIDTH) continue;
    if (em * r.px * FIGURE_MARGIN <= inner) return r.role;
  }
  return "text-heading";
}

/** A card's width in a row of `columns` in `width` px. */
export function statCardWidth(width: number, columns: number): number {
  return (width - (columns - 1) * STAT_GAP) / Math.max(1, columns);
}

/** A figure's colour per tone: the Pull Requests cards' (amber, red), emerald for ok, muted. */
const statTone: Readonly<Record<Tone, string>> = {
  "": "",
  muted: "text-cf-text-muted",
  attention: "text-cf-warning-text",
  error: "text-cf-error-text",
  ok: "text-cf-success-text",
};

/** A figure's tone class; an unknown tone (a newer plugin) is neutral. */
export function statToneClass(tone: string | undefined): string {
  return (statTone as Record<string, string | undefined>)[tone ?? ""] ?? "";
}

// ---- Bars ----------------------------------------------------------------------

/** The plot's height (px) and a bar's least height, so a zero still shows (and can be pointed at). */
export const BAR_PLOT_HEIGHT = 64;
export const BAR_MIN_HEIGHT = 2;
/** pluginsdk/ui BarMaxWidth. */
export const BAR_MAX_WIDTH = 40;

/** Bars' horizontal geometry in a plot `width` px wide: each bar's slot, the bar's width in it, and its left edge. */
export interface BarGeometry {
  slot: number;
  barWidth: number;
  x: (i: number) => number;
}

/**
 * Bars share the width in equal slots; a bar fills its slot less a gap (a fifth of the slot,
 * 1 to 6 px; none below 3 px slots, so 120 bars in a narrow panel stay visible), at most
 * BAR_MAX_WIDTH, centred in it.
 */
export function barGeometry(width: number, n: number): BarGeometry {
  const slot = width / Math.max(1, n);
  const gap = slot < 3 ? 0 : Math.min(6, Math.max(1, Math.round(slot / 5)));
  const barWidth = Math.max(0.5, Math.min(BAR_MAX_WIDTH, slot - gap));
  return { slot, barWidth, x: (i) => i * slot + (slot - barWidth) / 2 };
}

/** The value at the plot's top: the largest bar or the reference, whichever is higher (0 when all are 0). */
export function barScaleTop(data: Pick<BarsData, "bars" | "reference">): number {
  return Math.max(0, data.reference?.value ?? 0, ...data.bars.map((b) => b.value));
}

/** A bar's height for `value` on a plot whose top is `top` (at least BAR_MIN_HEIGHT; bad values are 0). */
export function barHeight(value: number, top: number): number {
  const v = Number.isFinite(value) && value > 0 ? value : 0;
  return top > 0 ? Math.max(BAR_MIN_HEIGHT, (v / top) * BAR_PLOT_HEIGHT) : BAR_MIN_HEIGHT;
}

/** The y of a value (a reference line) on the plot. */
export function barValueY(value: number, top: number): number {
  return top > 0 ? BAR_PLOT_HEIGHT * (1 - Math.min(1, Math.max(0, value) / top)) : BAR_PLOT_HEIGHT;
}

/** How a bar is painted: SVG fill classes, the series' colour variables, and hollow (running: an outline over a faint fill). */
export interface BarPaint {
  className: string;
  style?: CSSProperties;
  hollow: boolean;
}

/** SVG paint per status: the status tokens; running blue and hollow; pending, skipped and off muted. */
const STATUS_FILL: Readonly<Record<Exclude<Status, "">, string>> = {
  ok: "fill-cf-success stroke-cf-success",
  failed: "fill-cf-error stroke-cf-error",
  attention: "fill-cf-warning stroke-cf-warning",
  running: "fill-cf-info stroke-cf-info",
  pending: "fill-cf-text-muted stroke-cf-text-muted",
  skipped: "fill-cf-text-muted stroke-cf-text-muted",
  off: "fill-cf-text-muted stroke-cf-text-muted",
};

/** A bar's paint: its status's, else its series' in the app's chart palette (lib/usage SLOT_COLORS; 1 when unset or out of range). */
export function barPaint(bar: Pick<Bar, "status" | "series">): BarPaint {
  const byStatus = bar.status ? (STATUS_FILL as Record<string, string | undefined>)[bar.status] : undefined;
  if (byStatus) return { className: byStatus, hollow: bar.status === "running" };
  const s = bar.series;
  const slot = (Number.isInteger(s) && s !== undefined && s >= 1 && s <= 5 ? s : 1) as ModelSlot;
  return { className: "fill-(--sw-l) stroke-(--sw-l) dark:fill-(--sw-d) dark:stroke-(--sw-d)", style: slotColorVars(slot) as CSSProperties, hollow: false };
}

/** A bar's fill opacity: full when it is the highlighted one or none is, dimmed beside a highlighted one; a hollow bar's fill is faint. */
export function barOpacity(hollow: boolean, index: number, active: number | null): number {
  const base = hollow ? 0.3 : 0.85;
  return active === null || active === index ? base : base * 0.4;
}

/**
 * The highlighted bar after `key` from `index` (null: none yet) among `n`: arrows move one
 * (stopping at the ends), Home and End jump; null when the key does not move it.
 */
export function nextBar(index: number | null, key: string, n: number): number | null {
  if (n === 0) return null;
  const from = index ?? n - 1;
  switch (key) {
    case "ArrowRight":
      return index === null ? from : Math.min(n - 1, from + 1);
    case "ArrowLeft":
      return index === null ? from : Math.max(0, from - 1);
    case "Home":
      return 0;
    case "End":
      return n - 1;
  }
  return null;
}

/** The bar a pointer at `px` (from the plot's left) is over. */
export function barAt(px: number, width: number, n: number): number {
  if (n === 0 || width <= 0) return 0;
  return Math.min(n - 1, Math.max(0, Math.floor((px / width) * n)));
}
