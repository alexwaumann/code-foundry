import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import type { UsageBucketView } from "@/api/threads";
import { Button } from "@/components/ui/button";
import { DialogTitle } from "@/components/ui/dialog";
import { Tip } from "@/components/ui/tooltip";
import { SheetHeader } from "@/components/window/SheetHeader";
import { fmtShare, fmtTok, fmtUsd, type ModelUsage, type UsageTotals } from "@/lib/usage";
import { useThreadsStore } from "@/stores/threads";
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
 * Every thread's usage array (plugins' own threads too: they cost like any), then the
 * retired ledger last: one subscription, compared element by element, so only a usage
 * change (or a thread update that brings a new array) re-folds.
 */
function useAllUsage(): readonly (readonly UsageBucketView[])[] {
  return useThreadsStore(useShallow((s) => [...[...s.order, ...(s.owned ?? [])].map((id) => s.byId[id]?.usage ?? NONE), s.retiredUsage]));
}

function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}

/**
 * The Usage page (view.usage, the sidebar's chart button): spend and tokens over every
 * Code Foundry thread, live and removed, for a range of UTC days. Shown in the Usage
 * sheet (UsageSheet), which handles its Escape and focus. docs/sketches/session-usage/DESIGN.md "Views".
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
  const { totals } = data;
  const empty = totals.requests === 0 && totals.tokens === 0;

  return (
    <section className="flex min-h-0 flex-1 flex-col outline-none" aria-label="Usage" data-testid="usage-page" data-sheet-focus tabIndex={-1}>
      <SheetHeader className="gap-3 px-4">
        <DialogTitle>Usage</DialogTitle>
        <span className="ml-auto truncate text-caption">Code Foundry threads only</span>
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
        <Tip label="Close (Esc)">
          <Button variant="ghost" size="icon-xs" aria-label="Close usage" onClick={closeUsage} data-testid="usage-page-close">
            <X />
          </Button>
        </Tip>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1040px] px-8 pt-7 pb-10">
          <div className="text-display proportional-nums" data-testid="usage-page-total">
            {fmtUsd(totals.costUsd)}
          </div>
          <p className="mt-2 text-caption" data-testid="usage-page-summary">
            {(
              [
                [fmtTok(totals.tokens), plural(totals.tokens, "token", "tokens")],
                [totals.requests.toLocaleString("en-US"), plural(totals.requests, "request", "requests")],
                [String(data.threads), plural(data.threads, "thread", "threads")],
              ] as const
            ).map(([n, what], i) => (
              <span key={what}>
                {i > 0 && " · "}
                <b className="font-medium text-cf-text">{n}</b> {what}
              </span>
            ))}
          </p>
          {empty ? (
            <p className="mt-10 text-body text-cf-text-muted" data-testid="usage-page-empty">
              No usage in this range
            </p>
          ) : (
            <>
              <div className="mt-8 mb-2.5 flex items-center justify-between">
                <h2 className="text-subheading">
                  Daily<span className="ml-2 font-normal text-cf-text-muted">by model</span>
                </h2>
                <Segmented options={MODE_OPTIONS} value={mode} onChange={setMode} aria-label="Chart measure" data-testid="usage-page-mode" />
              </div>
              <UsageChart daily={data.daily} series={data.series} mode={mode} />
              <h2 className="mt-8 mb-2.5 text-subheading">By model</h2>
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
  const th = "px-2 py-1.5 text-caption-sm font-medium border-b border-cf-border";
  return (
    <table className="w-full border-collapse text-body-sm" data-testid="usage-page-models">
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
              <td className="border-b border-cf-border p-2">
                <span className="flex items-center">
                  <Swatch model={m.model} />
                  <span className="font-mono">{m.model}</span>
                  {m.unpriced && (
                    <span className="ml-1.5 rounded-sm border border-cf-border px-1.5 py-px text-caption-sm" data-testid="usage-page-unpriced">
                      unpriced
                    </span>
                  )}
                </span>
              </td>
              <td className="border-b border-cf-border p-2 text-right text-cf-text-muted tabular-nums">{m.requests.toLocaleString("en-US")}</td>
              <td className="border-b border-cf-border p-2 text-right tabular-nums">{fmtTok(m.tokens)}</td>
              <td className={`border-b border-cf-border p-2 text-right tabular-nums ${noRate ? "text-cf-text-muted" : ""}`}>{noRate ? "—" : fmtUsd(m.costUsd)}</td>
              <td className="border-b border-cf-border p-2 text-right text-cf-text-muted tabular-nums">{noRate ? "—" : fmtShare(m.costUsd, totalCost)}</td>
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
    <div className="mt-5 flex flex-wrap gap-8 border-t border-cf-border pt-4" data-testid="usage-page-buckets">
      {items.map(([k, v]) => (
        <div key={k}>
          <div className="text-caption-sm">{k}</div>
          <div className="mt-[3px] text-body font-medium tabular-nums">{fmtTok(v)}</div>
        </div>
      ))}
      <div className="ml-auto text-right" data-testid="usage-page-cache-savings">
        <div className="text-caption-sm">Cache savings</div>
        <div className="mt-[3px] text-body font-medium tabular-nums">{fmtUsd(cacheSavingsUsd)}</div>
      </div>
    </div>
  );
}
