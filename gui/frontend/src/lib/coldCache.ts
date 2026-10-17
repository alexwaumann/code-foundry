import type { SessionView } from "@/api/threads";
import type { DraftPhase } from "@/stores/compose";
import { sessionBadge } from "./thread";
import { fmtTok, fmtUsd } from "./usage";

/**
 * The cold-cache note of a thread's composer
 * (docs/notes/rendered-threads-cold-cache.md): once the conversation's prompt cache has
 * expired, the next message re-reads the whole context at the cache-write rate.
 */

/** How often a mounted composer re-checks the expiry, so the note appears while the user looks. */
export const COLD_CACHE_RECHECK_MS = 30_000;

export type ColdCacheInput = Pick<SessionView, "state" | "status" | "contextTokens" | "cacheExpiresAtMs" | "contextRereadUsd"> & {
  /** Pending permission requests and questions docked in the composer. */
  pending: number;
  /** The composer draft's phase: anything but idle means a send is on its way. */
  phase: DraftPhase;
  nowMs: number;
};

/**
 * The note, or null when it does not show. It shows for a thread that is idle (not
 * working, which includes Claude starting for a message just sent; nothing pending; no
 * send in flight), has a result (context tokens and an expiry), and whose cache expired at
 * or before now, whether or not Claude's process runs: the daemon stops an idle thread at
 * its expiry, so every stopped thread with a result shows it.
 */
export function coldCacheNote(i: ColdCacheInput): string | null {
  if (sessionBadge(i) === "busy") return null;
  if (i.pending > 0 || i.phase !== "idle") return null;
  if (!(i.contextTokens > 0) || i.cacheExpiresAtMs === null || i.nowMs < i.cacheExpiresAtMs) return null;
  const cost = i.contextRereadUsd > 0 ? ` (${fmtRereadUsd(i.contextRereadUsd)})` : "";
  return `Cache expired · the next message re-reads ${fmtTok(i.contextTokens)} tokens${cost}`;
}

/** An estimate in the Usage page's currency format: "~$0.08", "<$0.01" under a cent. */
export function fmtRereadUsd(v: number): string {
  return v < 0.01 ? "<$0.01" : `~${fmtUsd(v)}`;
}
