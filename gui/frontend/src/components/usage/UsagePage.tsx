import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { UsageBucketView } from "@/api/session";
import { Button } from "@/components/ui/button";
import { PaneHeader } from "@/components/window/PaneHeader";
import { useEscapeCloses } from "@/components/window/useEscapeCloses";
import { fmtShare, fmtTok, fmtUsd, type ModelUsage, type UsageTotals } from "@/lib/usage";
import { useSessionsStore } from "@/stores/sessions";
import { USAGE_RANGES, useUiStore, type UsageRange } from "@/stores/ui";
import { closeUsage } from "@/stores/views";
import { Segmented } from "./Segmented";
import { Swatch, UsageChart, type ChartMode } from "./UsageChart";
import { usagePageData, utcDays } from "./usageData";

const NONE: readonly UsageBucketView[] = [];
const RANGE_OPTIONS = USAGE_RANGES.map((d) => ({ value: d, label: d === 1 ? "1 day" : `${String(d)} days` }));
const MODE_OPTIONS: { value: ChartMode; label: string }[] = [
  { value: "tokens", label: "Tokens" },
  { value: "cost", label: "Cost" },
];

/**
 * Every thread's usage array, then the retired ledger last: one subscription, compared
 * element by element, so only a usage change (or a session update that brings a new
 * array) re-folds.
 */
function useAllUsage(): readonly (readonly UsageBucketView[])[] {
  return useSessionsStore(useShallow((s) => [...s.order.map((id) => s.byId[id]?.usage ?? NONE), s.retiredUsage]));
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * The Usage page (view.usage, the sidebar's chart button): spend and tokens over every
 * Code Foundry thread, live and removed, for a range of UTC days. Replaces the content
 * area like the settings page. docs/sketches/session-usage/DESIGN.md "Views".
 */
export function UsagePage() {
  const range = useUiStore((s) => s.usageRange);
  const setRange = useUiStore((s) => s.setUsageRange);
  const [mode, setMode] = useState<ChartMode>("tokens");
  const all = useAllUsage();
  const today = new Date().toISOString().slice(0, 10);
  const data = useMemo(() => {
    const days = utcDays(Date.parse(`${today}T12:00:00Z`), range);
    return usagePageData(all.slice(0, -1), all.at(-1) ?? NONE, days);
  }, [all, range, today]);
  useEscapeCloses(closeUsage);
  const { totals } = data;
  const empty = totals.requests === 0 && totals.tokens === 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col" aria-label="Usage" data-testid="usage-page" data-focus-root tabIndex={-1}>
      <PaneHeader className="gap-3 px-4">
        <h1 className="text-sm font-semibold">Usage</h1>
        <span className="ml-auto truncate text-xs text-muted-foreground">Code Foundry threads only</span>
        <Segmented
          options={RANGE_OPTIONS}
          value={range}
          onChange={(d: UsageRange) => {
            setRange(d);
          }}
          aria-label="Range"
          data-testid="usage-page-range"
          className="ml-1"
        />
        <Button variant="ghost" size="icon-xs" className="[--wails-draggable:no-drag]" aria-label="Close usage" title="Close (Esc)" onClick={closeUsage} data-testid="usage-page-close">
          <X />
        </Button>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1040px] px-8 pt-7 pb-10">
          <div className="text-[44px] leading-none font-semibold tracking-[-0.02em] proportional-nums" data-testid="usage-page-total">
            {fmtUsd(totals.costUsd)}
          </div>
          <p className="mt-2 text-[13px] text-muted-foreground" data-testid="usage-page-summary">
            {(
              [
                [fmtTok(totals.tokens), plural(totals.tokens, "token", "tokens")],
                [totals.requests.toLocaleString("en-US"), plural(totals.requests, "request", "requests")],
                [String(data.threads), plural(data.threads, "thread", "threads")],
              ] as const
            ).map(([n, what], i) => (
              <span key={what}>
                {i > 0 && " · "}
                <b className="font-medium text-foreground">{n}</b> {what}
              </span>
            ))}
          </p>
          {empty ? (
            <p className="mt-10 text-sm text-muted-foreground" data-testid="usage-page-empty">
              No usage in this range
            </p>
          ) : (
            <>
              <div className="mt-8 mb-2.5 flex items-center justify-between">
                <h2 className="text-[13px] font-semibold">
                  Daily<span className="ml-2 font-normal text-muted-foreground">by model</span>
                </h2>
                <Segmented options={MODE_OPTIONS} value={mode} onChange={setMode} aria-label="Chart measure" data-testid="usage-page-mode" />
              </div>
              <UsageChart daily={data.daily} series={data.series} mode={mode} />
              <h2 className="mt-8 mb-2.5 text-[13px] font-semibold">By model</h2>
              <ModelTable models={data.models} totalCost={totals.costUsd} />
              <BucketStrip totals={totals} cacheSavingsUsd={data.cacheSavingsUsd} />
            </>
          )}
        </div>
      </div>
    </section>
  );
}

function ModelTable({ models, totalCost }: { models: readonly ModelUsage[]; totalCost: number }) {
  const th = "px-2 py-1.5 text-[11px] font-medium text-muted-foreground border-b border-border";
  return (
    <table className="w-full border-collapse text-[13px]" data-testid="usage-page-models">
      <thead>
        <tr>
          <th className={`${th} text-left`}>Model</th>
          <th className={`${th} text-right`}>Requests</th>
          <th className={`${th} text-right`}>Tokens</th>
          <th className={`${th} text-right`}>Cost</th>
          <th className={`${th} text-right`}>Share</th>
        </tr>
      </thead>
      <tbody className="[&>tr:last-child>td]:border-b-0">
        {models.map((m) => {
          // A model with no rate at all: no cost and no share. One with some unpriced
          // buckets (fast mode on a model without it) keeps its priced part and the tag.
          const noRate = m.allUnpriced;
          return (
            <tr key={m.model} data-testid="usage-page-model-row" data-model={m.model}>
              <td className="border-b border-border p-2">
                <span className="flex items-center">
                  <Swatch model={m.model} />
                  <span className="font-mono">{m.model}</span>
                  {m.unpriced && (
                    <span className="ml-1.5 rounded border border-border px-1.5 py-px text-[10px] text-muted-foreground" data-testid="usage-page-unpriced">
                      unpriced
                    </span>
                  )}
                </span>
              </td>
              <td className="border-b border-border p-2 text-right text-muted-foreground tabular-nums">{m.requests.toLocaleString("en-US")}</td>
              <td className="border-b border-border p-2 text-right tabular-nums">{fmtTok(m.tokens)}</td>
              <td className={`border-b border-border p-2 text-right tabular-nums ${noRate ? "text-muted-foreground" : ""}`}>{noRate ? "—" : fmtUsd(m.costUsd)}</td>
              <td className="border-b border-border p-2 text-right text-muted-foreground tabular-nums">{noRate ? "—" : fmtShare(m.costUsd, totalCost)}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Bucket totals, then Cache savings right-aligned (UsageBucket.cache_savings_usd summed over the range). */
function BucketStrip({ totals, cacheSavingsUsd }: { totals: UsageTotals; cacheSavingsUsd: number }) {
  const items: [string, number][] = [
    ["Input", totals.input],
    ["Cache read", totals.cacheRead],
    ["Cache write · 5m", totals.cacheWrite5m],
    ["Cache write · 1h", totals.cacheWrite1h],
    ["Output", totals.output],
  ];
  return (
    <div className="mt-5 flex flex-wrap gap-8 border-t border-border pt-4" data-testid="usage-page-buckets">
      {items.map(([k, v]) => (
        <div key={k}>
          <div className="text-[11px] text-muted-foreground">{k}</div>
          <div className="mt-[3px] text-sm font-medium tabular-nums">{fmtTok(v)}</div>
        </div>
      ))}
      <div className="ml-auto text-right" data-testid="usage-page-cache-savings">
        <div className="text-[11px] text-muted-foreground">Cache savings</div>
        <div className="mt-[3px] text-sm font-medium tabular-nums">{fmtUsd(cacheSavingsUsd)}</div>
      </div>
    </div>
  );
}
