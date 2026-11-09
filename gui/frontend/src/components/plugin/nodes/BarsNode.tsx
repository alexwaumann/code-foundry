import { useId, useState, type KeyboardEvent, type PointerEvent } from "react";
import { inlineText } from "@/api/plugin";
import type { Bar } from "@/api/pluginCharts";
import { ChartCard } from "@/components/charts/ChartCard";
import { ChartTooltip } from "@/components/charts/ChartTooltip";
import { Tip } from "@/components/ui/tooltip";
import { useWidth } from "@/lib/useWidth";
import { cn } from "@/lib/utils";
import { useRunAction } from "../actions";
import { BAR_PLOT_HEIGHT, barAt, barGeometry, barHeight, barOpacity, barPaint, barScaleTop, barValueY, nextBar } from "../charts";
import { useViewCtx } from "../context";
import { GlyphView, InlineView } from "../parts";
import type { NodeProps } from "../registry";

/** The tooltip's top, from the plot's top (px). */
const TIP_TOP = 6;

/** A bar's tooltip: its status glyph (or series swatch) and title over its meta line. */
function BarTip({ bar }: { bar: Bar }) {
  const paint = barPaint(bar);
  return (
    <>
      <div className="flex items-center gap-1.5 font-semibold" data-testid="plugin-bar-tip-title">
        {bar.status ? (
          <GlyphView glyph={{ status: bar.status }} style="icon" named />
        ) : (
          <svg aria-hidden className="size-2.5 shrink-0" style={paint.style}>
            <rect width="10" height="10" rx="2" className={paint.className} />
          </svg>
        )}
        <span className="truncate">{bar.title}</span>
      </div>
      {bar.meta !== undefined && <InlineView value={bar.meta} className="block truncate text-cf-text-muted" />}
    </>
  );
}

/**
 * A small bar chart in the Pull Requests page's chart card (docs/notes/plugin-stats-bars.md):
 * title, subtitle and the reference line's label in the header, bars sharing the measured
 * width (charts.ts barGeometry), a dashed reference line, the axis' first and last labels.
 * Pointing at a bar, or the arrow keys once the chart has focus (one tab stop; Home and
 * End jump), highlights it, dims the others and shows the one tooltip; a bar with an
 * action acts on a click or Enter.
 */
export function BarsNode({ node, data }: NodeProps<"bars">) {
  const run = useRunAction();
  const { inert } = useViewCtx();
  const [ref, width] = useWidth(320);
  const [hover, setHover] = useState<number | null>(null);
  const [cursor, setCursor] = useState<number | null>(null);
  const liveId = useId();
  const bars = data.bars;
  const n = bars.length;
  const g = barGeometry(width, n);
  const top = barScaleTop(data);
  const raw = hover ?? cursor;
  const active = raw !== null && raw < n ? raw : null;
  const activeBar = active === null ? undefined : bars[active];
  const act = (i: number) => {
    const b = bars[i];
    if (b?.action && !inert) run(b.key, b.action);
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.key === "Enter" || e.key === " ") && active !== null) {
      e.preventDefault();
      act(active);
      return;
    }
    const next = nextBar(cursor, e.key, n);
    if (next === null) return;
    e.preventDefault();
    setHover(null);
    setCursor(next);
  };
  const onMove = (e: PointerEvent<HTMLDivElement>) => {
    if (n === 0) return;
    const r = e.currentTarget.getBoundingClientRect();
    setHover(barAt(e.clientX - r.left, r.width, n));
  };
  const refY = data.reference ? barValueY(data.reference.value, top) : null;
  const title = data.title ?? "";
  const subtitle = data.subtitle === undefined ? undefined : inlineText(data.subtitle);
  return (
    <ChartCard
      as="h3"
      heading={title || undefined}
      subtitle={
        data.subtitle === undefined ? undefined : (
          <Tip label={subtitle ?? ""} whenTruncated>
            <span className="block truncate">
              <InlineView value={data.subtitle} />
            </span>
          </Tip>
        )
      }
      trailing={data.reference?.label ? <span data-testid="plugin-bars-reference">{data.reference.label}</span> : undefined}
      className="shrink-0"
      data-testid="plugin-bars"
      data-key={node.key}
    >
      <div
        ref={ref}
        role="group"
        aria-roledescription="bar chart"
        aria-label={`${title || "Bars"}: ${String(n)} bars`}
        aria-describedby={liveId}
        tabIndex={n > 0 ? 0 : undefined}
        className={cn("relative rounded-sm outline-none focus-visible:ring-1 focus-visible:ring-cf-focus focus-visible:ring-offset-2 focus-visible:ring-offset-cf-surface", activeBar?.action && !inert && "cursor-pointer")}
        style={{ height: BAR_PLOT_HEIGHT }}
        onKeyDown={onKey}
        onFocus={() => {
          setCursor((c) => c ?? (n > 0 ? n - 1 : null));
        }}
        onBlur={() => {
          setCursor(null);
        }}
        onPointerMove={onMove}
        onPointerLeave={() => {
          setHover(null);
        }}
        onClick={() => {
          if (active !== null) act(active);
        }}
        data-testid="plugin-bars-plot"
        data-active={active ?? undefined}
        data-width={width}
      >
        <svg width={width} height={BAR_PLOT_HEIGHT} className="block overflow-visible" aria-hidden>
          {bars.map((b, i) => {
            const h = barHeight(b.value, top);
            const paint = barPaint(b);
            const bw = g.barWidth;
            return (
              <rect
                key={b.key}
                x={g.x(i)}
                y={BAR_PLOT_HEIGHT - h}
                width={bw}
                height={h}
                rx={Math.min(1.5, bw / 3)}
                className={paint.className}
                style={paint.style}
                fillOpacity={barOpacity(paint.hollow, i, active)}
                strokeOpacity={paint.hollow ? (active === null || active === i ? 1 : 0.4) : 0}
                strokeWidth={paint.hollow ? 1 : 0}
                strokeDasharray={paint.hollow ? "2 2" : undefined}
                data-testid="plugin-bar"
                data-key={b.key}
                data-status={b.status || undefined}
                data-series={b.status ? undefined : (b.series ?? 1)}
                data-active={active === i || undefined}
              />
            );
          })}
          {refY !== null && (
            <line x1={0} x2={width} y1={refY} y2={refY} className="stroke-cf-text-muted" strokeOpacity={0.7} strokeWidth={1} strokeDasharray="3 3" data-testid="plugin-bars-reference-line" />
          )}
        </svg>
        {n === 0 && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-caption" data-testid="plugin-bars-empty">
            No data yet
          </div>
        )}
        {activeBar && active !== null && (
          <ChartTooltip index={active} n={n} x={g.x(active) + g.barWidth / 2} width={width} top={TIP_TOP} gap={10} fit data-testid="plugin-bar-tip" data-key={activeBar.key}>
            <BarTip bar={activeBar} />
          </ChartTooltip>
        )}
        <span id={liveId} className="sr-only" aria-live="polite">
          {activeBar ? [activeBar.title, inlineText(activeBar.meta)].filter(Boolean).join(", ") : ""}
        </span>
      </div>
      {(data.startLabel || data.endLabel) && (
        <div className="mt-1 flex justify-between gap-3 text-caption-sm" data-testid="plugin-bars-axis">
          <span className="truncate">{data.startLabel}</span>
          <span className="truncate">{data.endLabel}</span>
        </div>
      )}
    </ChartCard>
  );
}
