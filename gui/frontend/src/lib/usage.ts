/**
 * Token usage, shared by the Usage side-panel surface and the Usage page
 * (docs/sketches/session-usage/DESIGN.md): folds over the daemon's usage buckets, the
 * fixed model colour slots, and the number formats. Pure; buckets come from
 * ThreadView.usage and the threads store's retiredUsage.
 */
import type { UsageBucketView } from "@/api/threads";

/** The five token counters of a bucket. */
export type TokenKind = "input" | "output" | "cacheRead" | "cacheWrite5m" | "cacheWrite1h";

/** A token kind's per-kind cost field on UsageBucketView. */
export type TokenKindCost = `${TokenKind}CostUsd`;

/** The token kinds in display order, with their labels and cost fields. */
export const TOKEN_KINDS: readonly { kind: TokenKind; cost: TokenKindCost; label: string }[] = [
  { kind: "input", cost: "inputCostUsd", label: "Input" },
  { kind: "output", cost: "outputCostUsd", label: "Output" },
  { kind: "cacheRead", cost: "cacheReadCostUsd", label: "Cache read" },
  { kind: "cacheWrite5m", cost: "cacheWrite5mCostUsd", label: "Cache write · 5m" },
  { kind: "cacheWrite1h", cost: "cacheWrite1hCostUsd", label: "Cache write · 1h" },
];

/** Counters and costs summed over buckets. */
export interface UsageTotals extends Record<TokenKind, number>, Record<TokenKindCost, number> {
  requests: number;
  /** All five token counters. */
  tokens: number;
  /** Sum over priced buckets. */
  costUsd: number;
  /** Some bucket had no known rate: costUsd is a lower bound. */
  unpriced: boolean;
  /** Every bucket was unpriced (and there was at least one): there is no cost to show. */
  allUnpriced: boolean;
}

/** One model's totals (usageByModel). */
export interface ModelUsage extends UsageTotals {
  model: string;
}

/** Totals over no buckets. */
export function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    tokens: 0,
    costUsd: 0,
    unpriced: false,
    allUnpriced: false,
    inputCostUsd: 0,
    outputCostUsd: 0,
    cacheReadCostUsd: 0,
    cacheWrite5mCostUsd: 0,
    cacheWrite1hCostUsd: 0,
  };
}

/** All five token counters of one bucket. */
export function bucketTokens(b: Pick<UsageBucketView, TokenKind>): number {
  return b.input + b.output + b.cacheRead + b.cacheWrite5m + b.cacheWrite1h;
}

/** Adds a bucket into t (mutates and returns t). `priced` counts buckets with a rate. */
function add(t: UsageTotals & { priced: number; buckets: number }, b: UsageBucketView): void {
  t.requests += b.requests;
  for (const k of TOKEN_KINDS) {
    t[k.kind] += b[k.kind];
    t[k.cost] += b[k.cost];
  }
  t.tokens += bucketTokens(b);
  t.costUsd += b.costUsd;
  t.unpriced ||= b.unpriced;
  t.buckets++;
  if (!b.unpriced) t.priced++;
}

function finish({ priced, buckets, ...t }: UsageTotals & { priced: number; buckets: number }): UsageTotals {
  return { ...t, allUnpriced: buckets > 0 && priced === 0 };
}

/** Totals over buckets (any mix of models and days). */
export function totalUsage(buckets: readonly UsageBucketView[]): UsageTotals {
  const t = { ...emptyTotals(), priced: 0, buckets: 0 };
  for (const b of buckets) add(t, b);
  return finish(t);
}

/**
 * Totals per model, most expensive first (then most tokens, then by id). Tiers, speeds
 * and days of one model fold together.
 */
export function usageByModel(buckets: readonly UsageBucketView[]): ModelUsage[] {
  const by = new Map<string, UsageTotals & { priced: number; buckets: number }>();
  for (const b of buckets) {
    let t = by.get(b.model);
    if (!t) by.set(b.model, (t = { ...emptyTotals(), priced: 0, buckets: 0 }));
    add(t, b);
  }
  return [...by]
    .map(([model, t]) => ({ model, ...finish(t) }))
    .sort((a, b) => b.costUsd - a.costUsd || b.tokens - a.tokens || a.model.localeCompare(b.model));
}

// ---- Model colours --------------------------------------------------------------

/** A colour slot: 1–4 are the known models in fixed order, 5 is everything else. */
export type ModelSlot = 1 | 2 | 3 | 4 | 5;

/** Fixed slot per model family (DESIGN.md: opus blue, fable orange, sonnet aqua, haiku yellow). */
export const MODEL_SLOTS: readonly (readonly [string, ModelSlot])[] = [
  ["claude-opus-5-5", 1],
  ["claude-fable-5-1", 2],
  ["claude-sonnet-5-5", 3],
  ["claude-haiku-5-5", 4],
];

/** Light and dark colours per slot (the mockup's --s1..--s5). */
export const SLOT_COLORS: Readonly<Record<ModelSlot, { light: string; dark: string }>> = {
  1: { light: "#2a78d6", dark: "#3987e5" },
  2: { light: "#eb6834", dark: "#d95926" },
  3: { light: "#1baf7a", dark: "#199e70" },
  4: { light: "#eda100", dark: "#c98500" },
  5: { light: "oklch(0.65 0 0)", dark: "oklch(0.6 0 0)" },
};

/** A model's slot: its id, or a dated or suffixed snapshot of it ("claude-haiku-5-5-20261001", "…[1m]"). */
export function modelSlot(model: string): ModelSlot {
  for (const [id, slot] of MODEL_SLOTS) {
    if (model === id || model.startsWith(`${id}-`) || model.startsWith(`${id}[`) || model.startsWith(`${id}@`)) return slot;
  }
  return 5;
}

/**
 * Inline style carrying a model's light and dark colours as --sw-l / --sw-d. Pair it with
 * the classes SWATCH_BG (or `fill-(--sw-l) dark:fill-(--sw-d)` for SVG), so the colour
 * follows the theme without a stylesheet entry.
 */
export function modelColorVars(model: string): Record<"--sw-l" | "--sw-d", string> {
  const c = SLOT_COLORS[modelSlot(model)];
  return { "--sw-l": c.light, "--sw-d": c.dark };
}

/** Background classes reading modelColorVars. */
export const SWATCH_BG = "bg-(--sw-l) dark:bg-(--sw-d)";

// ---- Formats ----------------------------------------------------------------------

const UNITS = [
  { at: 1e9, suffix: "B", digits: 2 },
  { at: 1e6, suffix: "M", digits: 1 },
  { at: 1e3, suffix: "K", digits: 1 },
] as const;

/**
 * Compact token count (the mockup's): 950, 1.2K, 38.9K, 980K, 3.4M, 10.7M, 349M, 1.5B,
 * 1.44B. Whole numbers from 100 of a unit up, else one decimal (two for B); trailing
 * zeros are dropped, and a value that rounds up to the next unit moves to it.
 */
export function fmtTok(n: number): string {
  for (let i = 0; i < UNITS.length; i++) {
    const u = UNITS[i];
    if (!u || n < u.at) continue;
    const v = n / u.at;
    const s = v.toFixed(v >= 100 ? 0 : u.digits);
    const bigger = UNITS[i - 1];
    if (bigger && Number(s) * u.at >= bigger.at) return fmtTok(bigger.at);
    return `${s.includes(".") ? s.replace(/\.?0+$/, "") : s}${u.suffix}`;
  }
  return String(Math.round(n));
}

/**
 * USD: cents with thousands separators; four decimals under a cent so small threads are
 * not $0.00, and "<$0.0001" for a sliver (a few input tokens) so it is not $0.0000.
 */
export function fmtUsd(v: number): string {
  if (v > 0 && v < 0.00005) return "<$0.0001";
  if (v > 0 && v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** part's share of total: "72.0%", "<0.1%" for a sliver, "—" without a total. */
export function fmtShare(part: number, total: number): string {
  if (!(total > 0)) return "—";
  const pct = (part / total) * 100;
  if (part > 0 && pct < 0.1) return "<0.1%";
  return `${pct.toFixed(1)}%`;
}

/** "1 request", "3 requests". */
export function fmtRequests(n: number): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? "request" : "requests"}`;
}
