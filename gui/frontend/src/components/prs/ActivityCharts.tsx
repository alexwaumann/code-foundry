import { useMemo, useState, type CSSProperties } from "react";
import type { MonthView } from "@/api/gh";
import { useNow } from "@/lib/clock";
import { slotColorVars, SWATCH_BG } from "@/lib/usage";
import { useWidth } from "@/lib/useWidth";
import { cn } from "@/lib/utils";
import { axisLabel, chartMonths, countScale, labelledIndex, tickLabel, tooltipSide, type ActivityMonth } from "./activity";
import { monthName } from "./format";

type SeriesKey = "merged" | "commits";

const SERIES: Record<SeriesKey, { label: string; unit: string; style: CSSProperties }> = {
  commits: { label: "Commits", unit: "commits", style: slotColorVars(1) as CSSProperties },
  merged: { label: "Merged PRs", unit: "merged prs", style: slotColorVars(2) as CSSProperties },
};

/** The tooltip lists both series, in this order, whichever card it is in. */
const TOOLTIP_SERIES: readonly SeriesKey[] = ["commits", "merged"];

const H = 170;
const LEFT = 44;
const RIGHT = 44;
const TOP = 10;
const BOTTOM = 22;
const PLOT_H = H - TOP - BOTTOM;

/** SVG paint reading SERIES[k].style (--sw-l / --sw-d), following the theme. */
const FILL = "fill-(--sw-l) dark:fill-(--sw-d)";
const STROKE = "stroke-(--sw-l) dark:stroke-(--sw-d)";

/** The month the pointer is over, and the card it is in (the one that shows the tooltip). */
interface Hover {
  index: number;
  card: SeriesKey;
}

type Pt = readonly [number, number];
const at = ([x, y]: Pt) => `${String(x)},${String(y)}`;
const polyline = (pts: readonly Pt[]) => pts.map((p, i) => `${i === 0 ? "M" : "L"}${at(p)}`).join(" ");

/**
 * Six months of merged PRs and commits, one line chart card each (merged left), sharing
 * the hovered month: both draw its band and crosshair, the card under the pointer shows
 * the one tooltip. docs/notes/prs-activity-chart.md.
 */
export function ActivityCharts({ months }: { months: readonly MonthView[] }) {
  const now = useNow(60_000);
  const chart = useMemo(() => chartMonths(months, now), [months, now]);
  const [hover, setHover] = useState<Hover | null>(null);
  const live = hover && hover.index < chart.length ? hover : null;
  return (
    <div className="@container" data-testid="activity">
      <div className="grid grid-cols-2 gap-4 @max-[760px]:grid-cols-1">
        <ActivityCard series="merged" months={chart} hover={live} onHover={setHover} now={now} />
        <ActivityCard series="commits" months={chart} hover={live} onHover={setHover} now={now} />
      </div>
    </div>
  );
}

function LineKey({ series, className }: { series: SeriesKey; className?: string }) {
  return <span aria-hidden className={cn("inline-block h-0.5 shrink-0 rounded-full", SWATCH_BG, className)} style={SERIES[series].style} />;
}

function ActivityCard({
  series,
  months,
  hover,
  onHover,
  now,
}: {
  series: SeriesKey;
  months: readonly ActivityMonth[];
  hover: Hover | null;
  onHover: (h: Hover | null) => void;
  now: number;
}) {
  const [ref, width] = useWidth(480);
  const s = SERIES[series];
  const n = months.length;
  const values = months.map((m) => m[series]);
  const { ticks, top } = n === 0 ? { ticks: [0], top: 1 } : countScale(Math.max(0, ...values));
  const y = (v: number) => TOP + PLOT_H * (1 - v / top);
  const slot = (width - LEFT - RIGHT) / Math.max(1, n);
  const x = (i: number) => LEFT + slot * i + slot / 2;
  const pts: Pt[] = values.map((v, i) => [x(i), y(v)]);
  const first = pts[0];
  const last = pts[n - 1];
  // The current month is partial: its marker is hollow and the segment into it dashed.
  const partialLast = months[n - 1]?.partial ?? false;
  const solid = partialLast ? pts.slice(0, -1) : pts;
  const beforeLast = pts[n - 2];
  const labelled = labelledIndex(months);
  const labelPt = pts[labelled];
  const hi = hover?.index ?? null;
  const hovered = hi === null ? undefined : months[hi];
  const showTip = hover?.card === series && hovered !== undefined && hi !== null;

  return (
    <section className="min-w-0 rounded-lg border px-4 py-3" data-testid={`activity-${series}`} aria-label={`${s.label}, last six months`}>
      <div className="mb-1.5 flex items-center">
        <LineKey series={series} className="mr-2 w-3.5" />
        <h2 className="text-label font-medium">{s.label}</h2>
        <span className="ml-2 text-label font-normal text-muted-foreground">last six months</span>
      </div>
      <div className="relative" ref={ref}>
        <svg width={width} height={H} className="block overflow-visible" role="img" aria-label={`${s.label} per month`} style={s.style}>
          <g>
            {ticks.map((v) => (
              <g key={v}>
                <line x1={LEFT} x2={width - RIGHT} y1={y(v)} y2={y(v)} className="stroke-foreground/8" strokeWidth={1} />
                <text x={LEFT - 8} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground text-caption-sm tabular-nums">
                  {tickLabel(v)}
                </text>
              </g>
            ))}
          </g>
          {hi !== null && <rect x={LEFT + slot * hi} y={TOP} width={slot} height={PLOT_H} className="fill-foreground/4" data-testid="activity-band" />}
          {first && last && (
            <path d={`${polyline(pts)} L${at([last[0], y(0)])} L${at([first[0], y(0)])} Z`} className={FILL} fillOpacity={0.1} stroke="none" />
          )}
          <path d={polyline(solid)} fill="none" className={STROKE} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
          {partialLast && beforeLast && last && (
            <path d={`M${at(beforeLast)} L${at(last)}`} fill="none" className={STROKE} strokeWidth={2} strokeDasharray="3 4" strokeLinecap="round" />
          )}
          {pts.map((p, i) => {
            const m = months[i];
            if (!m) return null;
            return (
              <circle
                key={m.month}
                cx={p[0]}
                cy={p[1]}
                r={hi === i ? 5 : 4}
                strokeWidth={2}
                className={m.partial ? cn("fill-pane", STROKE) : cn(FILL, "stroke-pane")}
                data-testid="activity-marker"
                data-month={m.month}
                data-value={m[series]}
                data-partial={m.partial || undefined}
              />
            );
          })}
          {labelPt && (
            <text x={labelPt[0] + 10} y={labelPt[1] + 4} className="fill-foreground text-caption-sm font-semibold tabular-nums" data-testid="activity-value">
              {tickLabel(values[labelled] ?? 0)}
            </text>
          )}
          {hi !== null && (
            <line x1={x(hi)} x2={x(hi)} y1={TOP} y2={H - BOTTOM} className="stroke-muted-foreground" strokeWidth={1} strokeDasharray="2 3" data-testid="activity-crosshair" />
          )}
          {months.map((m, i) => (
            <text key={m.month} x={x(i)} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-caption-sm">
              {axisLabel(m)}
            </text>
          ))}
          <g
            onMouseLeave={() => {
              onHover(null);
            }}
          >
            {months.map((m, i) => (
              <rect
                key={m.month}
                x={LEFT + slot * i}
                y={TOP}
                width={slot}
                height={H - TOP}
                fill="transparent"
                data-testid="activity-month"
                data-month={m.month}
                onMouseEnter={() => {
                  onHover({ index: i, card: series });
                }}
              />
            ))}
          </g>
        </svg>
        {n === 0 && (
          <div className="pointer-events-none absolute top-0 right-0 flex items-center justify-center text-caption" style={{ left: LEFT, height: H - BOTTOM }} data-testid="activity-empty">
            No stats yet
          </div>
        )}
        {showTip && (
          <div
            className="pointer-events-none absolute z-10 min-w-40 rounded-lg border border-border bg-popover px-2.5 py-2 text-caption-sm text-popover-foreground shadow-lg"
            style={tooltipSide(hi, n) === "left" ? { right: width - x(hi) + 14, top: TOP + 10 } : { left: x(hi) + 14, top: TOP + 10 }}
            data-testid="activity-tooltip"
            data-month={hovered.month}
            data-side={tooltipSide(hi, n)}
          >
            <div className="mb-1 text-muted-foreground">
              {monthName(hovered.month, now)}
              {hovered.partial ? " (so far)" : ""}
            </div>
            {TOOLTIP_SERIES.map((k) => (
              <div key={k} className="flex items-center gap-2 leading-relaxed" data-series={k}>
                <LineKey series={k} className="w-3" />
                <span className="min-w-7 font-semibold tabular-nums">{tickLabel(hovered[k])}</span>
                <span className="text-muted-foreground">{SERIES[k].unit}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
