/**
 * Mock usage buckets (Session.usage, SessionSnapshot.retired_usage) so the Usage page's
 * chart has shape: several models over the last two weeks, an empty day, one unpriced
 * model, and a retired ledger reaching back past 30 days (so 30 and 90 days differ).
 * Days are relative to the mock's "now", in UTC, like the daemon's buckets.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import type { UsageBucketSchema } from "../src/gen/codefoundry/v1/session_pb";

type BucketInit = MessageInitShape<typeof UsageBucketSchema>;

/** USD per million tokens: input, output, cache read, cache write 5m, cache write 1h. Illustrative only. */
const RATES: Record<string, readonly [number, number, number, number, number] | undefined> = {
  "claude-opus-5-5": [5, 25, 0.5, 6.25, 10],
  "claude-fable-5-1": [15, 75, 1.5, 18.75, 30],
  "claude-sonnet-5-5": [3, 15, 0.3, 3.75, 6],
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125, 0.2],
  "claude-opus-4-8": [5, 25, 0.5, 6.25, 10],
};

function day(now: Date, daysAgo: number): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - daysAgo)).toISOString().slice(0, 10);
}

/** A bucket of about `millions` million tokens, mostly cache reads, priced unless the model has no rate. */
function bucket(model: string, d: string, millions: number, requests: number): BucketInit {
  const total = Math.round(millions * 1e6);
  const input = Math.round(total * 0.00005);
  const output = Math.round(total * 0.003);
  const cacheWrite5m = Math.round(total * 0.005);
  const cacheWrite1h = Math.round(total * 0.03);
  const cacheRead = total - input - output - cacheWrite5m - cacheWrite1h;
  const r = RATES[model];
  const costUsd = r ? (input * r[0] + output * r[1] + cacheRead * r[2] + cacheWrite5m * r[3] + cacheWrite1h * r[4]) / 1e6 : 0;
  return {
    model,
    tier: "",
    speed: "",
    day: d,
    requests: BigInt(requests),
    input: BigInt(input),
    output: BigInt(output),
    cacheRead: BigInt(cacheRead),
    cacheWrite5m: BigInt(cacheWrite5m),
    cacheWrite1h: BigInt(cacheWrite1h),
    costUsd,
    unpriced: !r,
  };
}

// Millions of tokens per day, oldest (13 days ago) to today; 0 is no bucket. Day 9 ago is empty for every model.
const OPUS = [12, 58, 71, 40, 0, 95, 132, 118, 160, 210, 188, 141, 126, 88];
const FABLE = [4, 19, 22, 9, 0, 31, 48, 37, 52, 71, 64, 55, 49, 37];
const SONNET = [0, 0.2, 0, 0, 0, 0.1, 0.3, 0.2, 0.1, 0.2, 0.1, 0, 0.2, 0.1];
const HAIKU = [0, 0, 0, 0, 0, 0.1, 0.2, 0, 0.3, 0.1, 0.2, 0.1, 0.1, 0.1];

function series(now: Date, model: string, values: readonly number[], perRequest: number): BucketInit[] {
  return values.flatMap((m, i) => (m > 0 ? [bucket(model, day(now, values.length - 1 - i), m, Math.max(1, Math.round(m / perRequest)))] : []));
}

/** The usage of a mock session by id; empty for the others. */
export function mockUsage(sessionId: string, now: Date): BucketInit[] {
  switch (sessionId) {
    case "s-1":
      return series(now, "claude-opus-5-5", OPUS, 1);
    case "s-2":
      return series(now, "claude-sonnet-5-5", SONNET, 0.01);
    case "s-3":
      // An older model the rate table no longer knows: listed "unpriced" in the table.
      return [...series(now, "claude-fable-5-1", FABLE, 0.8), bucket("claude-opus-5", day(now, 2), 18, 9), bucket("claude-opus-5", day(now, 1), 10.4, 5)];
    case "s-4":
      return series(now, "claude-haiku-5-5", HAIKU, 0.04);
    default:
      return [];
  }
}

/** The retired ledger: removed threads' usage, 20 to 60 days ago, plus a priced model without a colour slot ("Other" on the chart). */
export function mockRetiredUsage(now: Date): BucketInit[] {
  return [
    bucket("claude-opus-5-5", day(now, 20), 64, 70),
    bucket("claude-fable-5-1", day(now, 20), 21, 25),
    bucket("claude-opus-5-5", day(now, 33), 90, 80),
    bucket("claude-opus-5-5", day(now, 60), 45, 40),
    bucket("claude-opus-4-8", day(now, 12), 6, 4),
  ];
}

/** Session.cost_usd / unpriced for a set of buckets, like the daemon's API layer. */
export function mockUsageTotals(buckets: readonly BucketInit[]): { costUsd: number; unpriced: boolean } {
  return { costUsd: buckets.reduce((a, b) => a + (b.costUsd ?? 0), 0), unpriced: buckets.some((b) => b.unpriced) };
}
