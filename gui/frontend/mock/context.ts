/**
 * Context totals of threads in the mock daemon
 * (docs/notes/rendered-threads-cold-cache.md): a thread's context size after its last
 * turn, when that turn ended, and from those and the sessions.cache_ttl_seconds setting the
 * cache expiry and the re-read cost, computed when sent like the daemon's.
 *
 *   POST /__mock/thread/cache?id=s-r1&ago=<seconds>[&tokens=N&model=M]
 *        moves the thread's last result <seconds> into the past (ago > the TTL: expired)
 */
import { timestampFromDate } from "@bufbuild/protobuf/wkt";

/** The part of a mock session the context fields read. */
export interface MockContext {
  contextTokens: number;
  /** The model that answered the last turn ("" unknown). */
  contextModel: string;
  /** When the last turn ended; null before the first result. */
  lastResultAt: Date | null;
}

/** Cache-write rates, USD per million tokens (internal/pricing's rows). */
const WRITE: Readonly<Record<string, { m5: number; h1: number }>> = {
  "claude-fable-5-1": { m5: 12.5, h1: 20 },
  "claude-opus-4-8": { m5: 6.25, h1: 10 },
  "claude-opus-5-5": { m5: 5, h1: 8 },
  "claude-sonnet-5": { m5: 2.5, h1: 4 },
  "claude-haiku-5-5": { m5: 0.125, h1: 0.2 },
};

/** The Session message's context_tokens, cache_expires_at and context_reread_usd. */
export function contextFields(c: MockContext, ttlSeconds: number) {
  if (!c.lastResultAt || c.contextTokens <= 0) return { contextTokens: 0n, contextRereadUsd: 0 };
  const w = WRITE[c.contextModel];
  const rate = w ? (ttlSeconds > 300 ? w.h1 : w.m5) : 0;
  return {
    contextTokens: BigInt(c.contextTokens),
    cacheExpiresAt: timestampFromDate(new Date(c.lastResultAt.getTime() + ttlSeconds * 1000)),
    contextRereadUsd: (c.contextTokens * rate) / 1e6,
  };
}

/** A turn ended: the context grew by what it added. */
export function recordResult(c: MockContext, model: string): void {
  c.contextTokens = (c.contextTokens || 24_200) + 1_500;
  if (model) c.contextModel = model;
  c.lastResultAt = new Date();
}
