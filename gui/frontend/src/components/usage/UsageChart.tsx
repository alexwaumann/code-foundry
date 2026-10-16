import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { fmtTok, fmtUsd, modelColorVars, SWATCH_BG } from "@/lib/usage";
import { cn } from "@/lib/utils";
import { dayLabel, labelledDays, niceStep, seriesLabel, type DayUsage } from "./usageData";

export type ChartMode = "tokens" | "cost";

const H = 220;
const LEFT = 56;
const RIGHT = 8;
const TOP = 8;
const BOTTOM = 24;
/** Surface gap between stacked segments, and the radius of a bar's top. */
const GAP = 2;
const RADIUS = 4;

/** A series' colour as --sw-l / --sw-d (lib/usage modelColorVars); OTHER has no slot, so it is grey. */
function seriesStyle(key: string): CSSProperties {
  return modelColorVars(key) as CSSProperties;
}

/** SVG fill reading seriesStyle, following the theme. */
const SERIES_FILL = "fill-(--sw-l) dark:fill-(--sw-d)";

function formatValue(v: number, mode: ChartMode): string {
  return mode === "cost" ? fmtUsd(v) : fmtTok(v);
}

/** Axis labels: "300M", "$25", "$7.5", "$0.001". */
function formatTick(v: number, mode: ChartMode): string {
  if (v === 0) return "0";
  return mode === "cost" ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 4 })}` : fmtTok(v);
}

/** A bar segment with only its top corners rounded (the data end; the base stays square). */
function topRoundedRect(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.max(0, Math.min(r, w / 2, h));
  return `M${String(x)},${String(y + h)}V${String(y + rr)}A${String(rr)},${String(rr)} 0 0 1 ${String(x + rr)},${String(y)}H${String(x + w - rr)}A${String(rr)},${String(rr)} 0 0 1 ${String(x + w)},${String(y + rr)}V${String(y + h)}Z`;
}

function useWidth(): [React.RefObject<HTMLDivElement | null>, number] {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(960);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (el.clientWidth > 0) setWidth(el.clientWidth);
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, []);
  return [ref, width];
}

interface Hover {
  index: number;
  x: number;
  y: number;
}

/**
 * Stacked daily bars by model (inline SVG): one slot per day of the range, empty days
 * included, series stacked in slot order from the baseline, a tooltip per day.
 */
export function UsageChart({ daily, series, mode }: { daily: readonly DayUsage[]; series: readonly string[]; mode: ChartMode }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState<Hover | null>(null);
  const values = (d: DayUsage) => (mode === "cost" ? d.cost : d.tokens);
  const totals = daily.map((d) => series.reduce((a, k) => a + (values(d)[k] ?? 0), 0));
  const max = Math.max(0, ...totals);
  const step = niceStep(max);
  const top = Math.max(step, Math.ceil(max / step - 1e-9) * step);
  const y = (v: number) => TOP + (H - TOP - BOTTOM) * (1 - v / top);
  const n = daily.length;
  const slot = (width - LEFT - RIGHT) / Math.max(1, n);
  const bw = Math.min(28, slot * 0.6);
  const grid: number[] = [];
  for (let v = 0; v <= top + step / 1e6; v += step) grid.push(v);
  const hovered = hover ? daily[hover.index] : undefined;

  return (
    <div className="relative mt-1" ref={ref} data-testid="usage-page-chart" data-mode={mode}>
      <svg width={width} height={H} className="block overflow-visible" role="img" aria-label={`Daily ${mode} by model`}>
        <g>
          {grid.map((v) => (
            <g key={v}>
              <line x1={LEFT} x2={width - RIGHT} y1={y(v)} y2={y(v)} className="stroke-foreground/8" strokeWidth={1} />
              <text x={LEFT - 8} y={y(v) + 4} textAnchor="end" className="fill-muted-foreground text-caption-sm tabular-nums">
                {formatTick(v, mode)}
              </text>
            </g>
          ))}
        </g>
        {daily.map((d, i) => {
          const x = LEFT + slot * i + (slot - bw) / 2;
          // Segments too thin to show past the gap are left out (the tooltip still lists
          // them), so the rounded end sits on the topmost visible one. A bar made only of
          // slivers keeps its largest, at least 1px tall.
          const present = series.filter((k) => (values(d)[k] ?? 0) > 0);
          const visible = present.filter((k) => y(0) - y(values(d)[k] ?? 0) > GAP + 1);
          const largest = present.reduce<string | undefined>((m, k) => (m === undefined || (values(d)[k] ?? 0) > (values(d)[m] ?? 0) ? k : m), undefined);
          const drawn = visible.length > 0 ? visible : largest === undefined ? [] : [largest];
          let acc = 0;
          return (
            <g key={d.day} data-day={d.day}>
              {hover?.index === i && <rect x={LEFT + slot * i} y={TOP} width={slot} height={H - TOP - BOTTOM} className="fill-foreground/4" />}
              {drawn.map((k, j) => {
                const v = values(d)[k] ?? 0;
                const y0 = y(acc + v);
                const base = y(acc) - (j > 0 ? GAP : 0);
                acc += v;
                const h = Math.max(base - y0, 1);
                const isTop = j === drawn.length - 1;
                return (
                  <path
                    key={k}
                    d={isTop ? topRoundedRect(x, y0, bw, h, RADIUS) : `M${String(x)},${String(y0)}h${String(bw)}v${String(h)}h${String(-bw)}Z`}
                    className={SERIES_FILL}
                    style={seriesStyle(k)}
                    data-series={k}
                  />
                );
              })}
            </g>
          );
        })}
        <g>
          {labelledDays(n).map((i) => {
            const d = daily[i];
            return d ? (
              <text key={d.day} x={LEFT + slot * i + slot / 2} y={H - 6} textAnchor="middle" className="fill-muted-foreground text-caption-sm">
                {dayLabel(d.day).toUpperCase()}
              </text>
            ) : null;
          })}
        </g>
        {daily.map((d, i) => (
          <rect
            key={d.day}
            x={LEFT + slot * i}
            y={TOP}
            width={slot}
            height={H - TOP - BOTTOM}
            fill="transparent"
            data-testid="usage-page-day"
            data-day={d.day}
            onMouseMove={(e) => {
              // Pointer and rect are viewport px; the tooltip's left/top are layout px, so
              // divide by the page zoom (rendered width over layout width; lib/zoom.ts).
              const el = ref.current;
              const b = el?.getBoundingClientRect();
              const scale = el && b && el.offsetWidth > 0 ? b.width / el.offsetWidth : 1;
              setHover({ index: i, x: (e.clientX - (b?.left ?? 0)) / scale, y: (e.clientY - (b?.top ?? 0)) / scale });
            }}
            onMouseLeave={() => {
              setHover(null);
            }}
          />
        ))}
      </svg>
      {hover && hovered && (totals[hover.index] ?? 0) > 0 && (
        <div
          className="pointer-events-none absolute z-10 min-w-40 rounded-lg border border-border bg-popover px-2.5 py-2 text-caption-sm text-popover-foreground shadow-lg"
          style={{ left: Math.max(0, Math.min(hover.x + 14, width - 220)), top: Math.max(0, hover.y - 10) }}
          data-testid="usage-page-tooltip"
        >
          <div className="mb-1 text-muted-foreground">{dayLabel(hovered.day)}</div>
          {series
            .filter((k) => (hovered.tokens[k] ?? 0) > 0)
            .map((k) => (
              <div key={k} className="flex justify-between gap-4 leading-relaxed">
                <span className="flex items-center">
                  <Swatch model={k} />
                  {seriesLabel(k)}
                </span>
                <span className="tabular-nums">{formatValue(values(hovered)[k] ?? 0, mode)}</span>
              </div>
            ))}
          <div className="mt-1 flex justify-between gap-4 border-t border-border pt-1 font-semibold">
            <span>Total</span>
            <span className="tabular-nums">{formatValue(totals[hover.index] ?? 0, mode)}</span>
          </div>
        </div>
      )}
      <div className="mt-2.5 flex flex-wrap gap-3.5 text-caption-sm" data-testid="usage-page-legend">
        {series.map((k) => (
          <span key={k} className="inline-flex items-center" data-series={k}>
            <Swatch model={k} />
            {seriesLabel(k)}
          </span>
        ))}
      </div>
    </div>
  );
}

/** A model's (or series') colour square; grey for a model without a slot. */
export function Swatch({ model }: { model: string }) {
  return <span aria-hidden className={cn("mr-2 inline-block size-2 shrink-0", SWATCH_BG)} style={seriesStyle(model)} />;
}
