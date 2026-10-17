/**
 * Mock token usage (docs/notes/session-usage.md): a session's buckets priced like the
 * daemon's internal/pricing for the few models the fixtures use; any other model is
 * unpriced. Seeded on s-1; POST /__mock/usage adds a bucket to any session.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { UsageBucketSchema } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";

type UsageBucketInit = MessageInitShape<typeof UsageBucketSchema>;

/** One bucket as the mock keeps it (counters are plain numbers). */
export interface MockUsage {
  model: string;
  tier?: string;
  speed?: string;
  /** UTC "YYYY-MM-DD". */
  day: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
}

/** USD per million tokens: rows copied from internal/pricing (standard tier and speed). */
const RATES: Record<string, { input: number; output: number; cacheRead: number; cacheWrite5m: number; cacheWrite1h: number }> = {
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25, cacheWrite5m: 12.5, cacheWrite1h: 20 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite5m: 5, cacheWrite1h: 8 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1, cacheWrite5m: 2.5, cacheWrite1h: 4 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite5m: 0.125, cacheWrite1h: 0.2 },
  "claude-opus-4-8": { input: 5, output: 25, cacheRead: 0.5, cacheWrite5m: 6.25, cacheWrite1h: 10 },
};

function bucketMsg(u: MockUsage): UsageBucketInit {
  const r = !u.tier && !u.speed ? RATES[u.model] : undefined;
  const cost = (n: number, rate: number | undefined) => (r && rate !== undefined ? (n * rate) / 1e6 : 0);
  const c = {
    inputCostUsd: cost(u.input, r?.input),
    outputCostUsd: cost(u.output, r?.output),
    cacheReadCostUsd: cost(u.cacheRead, r?.cacheRead),
    cacheWrite5mCostUsd: cost(u.cacheWrite5m, r?.cacheWrite5m),
    cacheWrite1hCostUsd: cost(u.cacheWrite1h, r?.cacheWrite1h),
  };
  return {
    model: u.model,
    tier: u.tier ?? "",
    speed: u.speed ?? "",
    day: u.day,
    requests: BigInt(u.requests),
    input: BigInt(u.input),
    output: BigInt(u.output),
    cacheRead: BigInt(u.cacheRead),
    cacheWrite5m: BigInt(u.cacheWrite5m),
    cacheWrite1h: BigInt(u.cacheWrite1h),
    costUsd: c.inputCostUsd + c.outputCostUsd + c.cacheReadCostUsd + c.cacheWrite5mCostUsd + c.cacheWrite1hCostUsd,
    unpriced: !r,
    // pricing.CacheSavings: cache reads at (input rate - cache read rate).
    cacheSavingsUsd: cost(u.cacheRead, r ? r.input - r.cacheRead : undefined),
    ...c,
  };
}

/** Session.usage, cost_usd and unpriced for a session's buckets. */
export function usageFields(list: readonly MockUsage[]): { usage: UsageBucketInit[]; costUsd: number; unpriced: boolean } {
  const usage = [...list].sort((a, b) => a.day.localeCompare(b.day) || a.model.localeCompare(b.model)).map(bucketMsg);
  return { usage, costUsd: usage.reduce((s, b) => s + (b.costUsd ?? 0), 0), unpriced: usage.some((b) => b.unpriced) };
}

/** UTC "YYYY-MM-DD", daysAgo before now. */
export function utcDay(daysAgo = 0): string {
  return new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

/**
 * s-1's usage: Opus 5.5 over two days and Fable 5.1, about the mockup's thread
 * ($141, 362M tokens, 412 requests).
 */
export function sampleUsage(): MockUsage[] {
  return [
    { model: "claude-opus-5-5", day: utcDay(1), requests: 170, input: 5800, output: 420_000, cacheRead: 148_000_000, cacheWrite5m: 640_000, cacheWrite1h: 4_300_000 },
    { model: "claude-opus-5-5", day: utcDay(0), requests: 120, input: 4000, output: 300_000, cacheRead: 104_000_000, cacheWrite5m: 460_000, cacheWrite1h: 3_100_000 },
    { model: "claude-fable-5-1", day: utcDay(0), requests: 122, input: 3100, output: 260_000, cacheRead: 97_000_000, cacheWrite5m: 400_000, cacheWrite1h: 3_300_000 },
  ];
}

// ---- The Usage page's fixtures -----------------------------------------------------
// Two weeks of four models on s-3 and s-4 (s-1 keeps sampleUsage, s-2 stays empty for the
// panel's "No usage yet"), an empty day, an unpriced model, and a retired ledger reaching
// past 30 days with a priced model without a colour slot ("Other").

/** A bucket of about `millions` million tokens, mostly cache reads (the real mix). */
function mix(model: string, daysAgo: number, millions: number, requests: number): MockUsage {
  const total = Math.round(millions * 1e6);
  const input = Math.round(total * 0.00005);
  const output = Math.round(total * 0.003);
  const cacheWrite5m = Math.round(total * 0.005);
  const cacheWrite1h = Math.round(total * 0.03);
  return { model, day: utcDay(daysAgo), requests, input, output, cacheRead: total - input - output - cacheWrite5m - cacheWrite1h, cacheWrite5m, cacheWrite1h };
}

// Millions of tokens per day, 13 days ago to today; 0 is no bucket (9 days ago is empty for every model).
const OPUS = [12, 58, 71, 40, 0, 95, 132, 118, 160, 210, 188, 141, 126, 88];
const FABLE = [4, 19, 22, 9, 0, 31, 48, 37, 52, 71, 64, 55, 49, 37];
const SONNET = [0, 0.2, 0, 0, 0, 0.1, 0.3, 0.2, 0.1, 0.2, 0.1, 0, 0.2, 0.1];
const HAIKU = [0, 0, 0, 0, 0, 0.1, 0.2, 0, 0.3, 0.1, 0.2, 0.1, 0.1, 0.1];

function daily(model: string, values: readonly number[], perRequest: number): MockUsage[] {
  return values.flatMap((m, i) => (m > 0 ? [mix(model, values.length - 1 - i, m, Math.max(1, Math.round(m / perRequest)))] : []));
}

/** s-3: Opus 5.5 every day, plus claude-opus-5 (no rate: "unpriced"). s-4: Fable, Sonnet and Haiku. */
export function pageUsage(sessionId: string): MockUsage[] {
  switch (sessionId) {
    case "s-3":
      return [...daily("claude-opus-5-5", OPUS, 1), mix("claude-opus-5", 2, 18, 9), mix("claude-opus-5", 1, 10.4, 5)];
    case "s-4":
      return [...daily("claude-fable-5-1", FABLE, 0.8), ...daily("claude-sonnet-5-5", SONNET, 0.01), ...daily("claude-haiku-5-5", HAIKU, 0.04)];
    default:
      return [];
  }
}

/** SessionSnapshot.retired_usage / ListSessionsResponse.retired_usage: removed threads' usage. */
export function retiredUsage(): UsageBucketInit[] {
  return usageFields([mix("claude-opus-5-5", 20, 64, 70), mix("claude-fable-5-1", 20, 21, 25), mix("claude-opus-5-5", 33, 90, 80), mix("claude-opus-5-5", 60, 45, 40), mix("claude-opus-4-8", 12, 6, 4)]).usage;
}
