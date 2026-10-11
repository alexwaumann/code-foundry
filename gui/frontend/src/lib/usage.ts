/**
 * Token usage helpers shared by the usage views (docs/sketches/session-usage/DESIGN.md):
 * number formats, the per-model colour map, and folds over UsageBucketView. Costs come
 * priced per bucket from the daemon; nothing here knows a rate.
 */
import type { UsageBucketView } from "@/api/session";
import type { ColorScheme } from "@/lib/theme";

/** "1.94B", "500M", "1.12M", "85.0K", "320K", "912". */
export function formatTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(n >= 1e5 ? 0 : 1)}K`;
  return String(Math.round(n));
}

/** "$6,912.40"; under a cent (but not zero) four decimals, "$0.0029", like the CLI. */
export function formatUsd(n: number): string {
  const digits = n > 0 && n < 0.01 ? 4 : 2;
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** "67.3%", "<0.1%" for a sliver, "—" when there is no whole to share. */
export function formatShare(part: number, whole: number): string {
  if (whole <= 0) return "—";
  const pct = (part / whole) * 100;
  if (pct > 0 && pct < 0.1) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}

/**
 * The chart's fixed colour slots, in order (the dataviz reference palette's steps,
 * validated in the sketch). A model without a slot is grey.
 */
export const MODEL_SLOTS = ["claude-opus-5-5", "claude-fable-5-1", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;

const SLOT_COLORS: Record<ColorScheme, readonly string[]> = {
  dark: ["#3987e5", "#d95926", "#199e70", "#c98500"],
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"],
};
const OTHER_COLOR: Record<ColorScheme, string> = { dark: "oklch(0.6 0 0)", light: "oklch(0.65 0 0)" };

/** The model's slot in MODEL_SLOTS, or -1. */
export function modelSlot(model: string): number {
  return (MODEL_SLOTS as readonly string[]).indexOf(model);
}

/** The model's colour in the scheme; grey for a model without a slot. */
export function modelColor(model: string, scheme: ColorScheme): string {
  const slot = modelSlot(model);
  return slot < 0 ? OTHER_COLOR[scheme] : (SLOT_COLORS[scheme][slot] ?? OTHER_COLOR[scheme]);
}

/** Every token a bucket counts: input, output, cache reads and both cache writes. */
export function bucketTokens(b: Pick<UsageBucketView, "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h">): number {
  return b.input + b.output + b.cacheRead + b.cacheWrite5m + b.cacheWrite1h;
}

export interface UsageTotals {
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** All five token counters. */
  tokens: number;
  /** Priced buckets only. */
  costUsd: number;
  /** Some bucket had no rate: costUsd is a lower bound. */
  unpriced: boolean;
}

export const emptyTotals: UsageTotals = { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, tokens: 0, costUsd: 0, unpriced: false };

/** Sums buckets (any mix of models and days). */
export function sumBuckets(buckets: Iterable<UsageBucketView>): UsageTotals {
  const t = { ...emptyTotals };
  for (const b of buckets) {
    t.requests += b.requests;
    t.input += b.input;
    t.output += b.output;
    t.cacheRead += b.cacheRead;
    t.cacheWrite5m += b.cacheWrite5m;
    t.cacheWrite1h += b.cacheWrite1h;
    t.tokens += bucketTokens(b);
    t.costUsd += b.costUsd;
    t.unpriced ||= b.unpriced;
  }
  return t;
}

export interface ModelUsage extends UsageTotals {
  model: string;
}

/** Totals per model, by cost (highest first), then tokens, then id. */
export function byModel(buckets: Iterable<UsageBucketView>): ModelUsage[] {
  const groups = new Map<string, UsageBucketView[]>();
  for (const b of buckets) {
    const g = groups.get(b.model);
    if (g) g.push(b);
    else groups.set(b.model, [b]);
  }
  return [...groups]
    .map(([model, bs]) => ({ model, ...sumBuckets(bs) }))
    .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.model.localeCompare(b.model));
}
