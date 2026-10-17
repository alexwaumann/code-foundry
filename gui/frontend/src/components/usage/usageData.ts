/**
 * The Usage page's data: every tracked thread's buckets plus the retired ledger, kept to
 * the range's UTC days, folded into the hero totals, the per-model table and the daily
 * chart series. docs/notes/session-usage.md "Usage page".
 */
import type { UsageBucketView } from "@/api/threads";
import { MODEL_SLOTS, bucketTokens, modelSlot, totalUsage, usageByModel, type ModelUsage, type UsageTotals } from "@/lib/usage";

const DAY_MS = 86_400_000;

/** The chart series for models without a colour slot. */
export const OTHER = "other";

/** The last `n` UTC days ending today, oldest first, as "YYYY-MM-DD". */
export function utcDays(nowMs: number, n: number): string[] {
  const today = Math.floor(nowMs / DAY_MS) * DAY_MS;
  return Array.from({ length: n }, (_, i) => new Date(today - (n - 1 - i) * DAY_MS).toISOString().slice(0, 10));
}

/** "2026-10-06" → "Oct 6". */
export function dayLabel(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? day : d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}

/** A series' name in the legend and tooltip. */
export function seriesLabel(key: string): string {
  return key === OTHER ? "Other" : key;
}

/**
 * The chart series a model belongs to: its colour slot's model id (so a dated or suffixed
 * snapshot stacks with its family), else OTHER.
 */
export function seriesOf(model: string): string {
  const slot = modelSlot(model);
  return MODEL_SLOTS.find(([, s]) => s === slot)?.[0] ?? OTHER;
}

/** A 1, 2, 2.5 or 5 × 10^k grid step giving about four lines up to `max`. */
export function niceStep(max: number): number {
  if (!(max > 0)) return 1;
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * pow;
}

/**
 * Indexes of the day slots that get an axis label: every few days from the first (about
 * eight labels) and always the last (today), dropping a regular one that would crowd it.
 */
export function labelledDays(n: number): number[] {
  if (n <= 0) return [];
  const step = Math.max(1, Math.ceil(n / 8));
  const out: number[] = [];
  for (let i = 0; i < n - 1; i += step) if (n - 1 - i >= step / 2) out.push(i);
  out.push(n - 1);
  return out;
}

export interface DayUsage {
  day: string;
  /** Per series key; absent means none. */
  tokens: Record<string, number>;
  cost: Record<string, number>;
}

export interface UsagePageData {
  totals: UsageTotals;
  /** USD the cache reads saved over the range (UsageBucket.cache_savings_usd summed; 0 for unpriced buckets). */
  cacheSavingsUsd: number;
  /** Tracked threads with usage in the range (removed threads are not counted: the ledger has no ids). */
  threads: number;
  models: ModelUsage[];
  /** Series with usage in the range, slot order, OTHER last. */
  series: string[];
  /** One entry per day of the range, empty days included. */
  daily: DayUsage[];
}

/**
 * Folds the threads' usage (one array per thread) and the retired ledger over `days`.
 * Buckets on other days, and those of day "unknown", are left out.
 */
export function usagePageData(threads: readonly (readonly UsageBucketView[])[], retired: readonly UsageBucketView[], days: readonly string[]): UsagePageData {
  const index = new Map(days.map((d, i) => [d, i]));
  const daily: DayUsage[] = days.map((day) => ({ day, tokens: {}, cost: {} }));
  const inRange: UsageBucketView[] = [];
  const seen = new Set<string>();
  let threadCount = 0;
  const take = (bs: readonly UsageBucketView[]): boolean => {
    let any = false;
    for (const b of bs) {
      const i = index.get(b.day);
      if (i === undefined) continue;
      any = true;
      inRange.push(b);
      const d = daily[i];
      if (!d) continue;
      const key = seriesOf(b.model);
      seen.add(key);
      d.tokens[key] = (d.tokens[key] ?? 0) + bucketTokens(b);
      d.cost[key] = (d.cost[key] ?? 0) + b.costUsd;
    }
    return any;
  };
  for (const bs of threads) if (take(bs)) threadCount++;
  take(retired);
  const series: string[] = MODEL_SLOTS.map(([m]) => m).filter((m) => seen.has(m));
  if (seen.has(OTHER)) series.push(OTHER);
  const cacheSavingsUsd = inRange.reduce((s, b) => s + b.cacheSavingsUsd, 0);
  return { totals: totalUsage(inRange), cacheSavingsUsd, threads: threadCount, models: usageByModel(inRange), series, daily };
}
