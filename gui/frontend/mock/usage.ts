/**
 * Mock token usage (docs/notes/session-usage.md): a session's buckets priced like the
 * daemon's internal/pricing for the few models the fixtures use; any other model is
 * unpriced. Seeded on s-1; POST /__mock/usage adds a bucket to any session.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { UsageBucketSchema } from "../src/gen/codefoundry/v1/session_pb";

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
