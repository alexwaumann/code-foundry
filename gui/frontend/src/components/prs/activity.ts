/**
 * The Pull Requests page's activity charts (docs/notes/prs-activity-chart.md): six months
 * of commits and merged PRs from DashboardView.stats.months, one line chart per series.
 * Pure: the month list, the y scale, labels and the tooltip side.
 */
import type { MonthView } from "@/api/gh";
import { niceStep } from "@/components/usage/usageData";

/** A month on the chart's x axis. */
export interface ActivityMonth extends MonthView {
  /** The month `now` is in: its counts are so far, not final. */
  partial: boolean;
}

/** "YYYY-MM" of the local month `now` is in (the daemon buckets in its own time zone, this machine's). */
export function monthLabelAt(now: number): string {
  const d = new Date(now);
  return `${String(d.getFullYear())}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * The daemon's newest-first months, oldest first for the x axis, each marked partial
 * when it is `now`'s month. Months without a label (never fetched) are left out.
 */
export function chartMonths(newestFirst: readonly MonthView[], now: number): ActivityMonth[] {
  const current = monthLabelAt(now);
  return newestFirst
    .filter((m) => m.month !== "")
    .map((m) => ({ ...m, partial: m.month === current }))
    .reverse();
}

/**
 * Index (oldest-first) of the month that gets the direct value label: the newest closed
 * month. That is the one before the current month; when the snapshot predates a rollover
 * (no month is partial) it is the newest. -1 when there is none.
 */
export function labelledIndex(months: readonly ActivityMonth[]): number {
  for (let i = months.length - 1; i >= 0; i--) if (!months[i]?.partial) return i;
  return -1;
}

/** The y scale over counts: whole-number gridlines from 0 to the rounded-up max. */
export interface CountScale {
  step: number;
  top: number;
  ticks: number[];
}

/** niceStep for whole counts: at least 1, and 2 where niceStep would give 2.5. */
export function countStep(max: number): number {
  const s = niceStep(max);
  if (s < 1) return 1;
  return Number.isInteger(s) ? s : Math.floor(s);
}

export function countScale(max: number): CountScale {
  const step = countStep(max);
  const top = Math.max(step, Math.ceil(max / step - 1e-9) * step);
  const ticks: number[] = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  return { step, top, ticks };
}

/** Which side of the crosshair the tooltip goes: the side of the card with more room. */
export function tooltipSide(index: number, n: number): "left" | "right" {
  return index >= n / 2 ? "left" : "right";
}

/** "2026-10" -> "OCT"; the partial month gets " ·". */
export function axisLabel(m: Pick<ActivityMonth, "month" | "partial">): string {
  const r = /^(\d{4})-(\d{2})$/.exec(m.month);
  if (!r) return "";
  const short = new Date(Number(r[1]), Number(r[2]) - 1, 1).toLocaleString("en-US", { month: "short" }).toUpperCase();
  return m.partial ? `${short} ·` : short;
}

/** Axis tick: "0", "40", "1,500". */
export function tickLabel(v: number): string {
  return v.toLocaleString("en-US");
}
