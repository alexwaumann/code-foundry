import type { ApiRetryView, SessionView } from "@/api/session";

/**
 * The composer's "Rate limited · retrying in 20 s (attempt 3 of 10)" line
 * (docs/notes/api-retry-note.md): Claude Code retries failed API requests itself, and
 * without this line a thread that waits on a 429 only shows "Working" with no output.
 */

/** How often a mounted note re-reads the clock, so the countdown moves. */
export const RETRY_RECHECK_MS = 1_000;

export type RetryNoteInput = Pick<SessionView, "retry"> & { nowMs: number };

/** What failed, in words: Claude's error category first, the HTTP status as a fallback. */
export function retryCause(r: Pick<ApiRetryView, "error" | "errorStatus">): string {
  switch (r.error) {
    case "rate_limit":
      return "Rate limited";
    case "overloaded":
      return "API overloaded";
    case "connection":
    case "network":
      return "No response from the API";
  }
  if (r.errorStatus === 429) return "Rate limited";
  if (r.errorStatus === 529) return "API overloaded";
  if (r.errorStatus > 0) return `API error ${String(r.errorStatus)}`;
  return r.error ? `API error (${r.error})` : "API error";
}

/** "20 s", "1 min 5 s", "3 min"; whole seconds, rounded up. */
export function fmtRetryIn(ms: number): string {
  const s = Math.max(1, Math.ceil(ms / 1000));
  if (s < 60) return `${String(s)} s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest === 0 ? `${String(m)} min` : `${String(m)} min ${String(rest)} s`;
}

/**
 * The note, or null when it does not show: a thread with a pending retry (the daemon
 * clears it when the process ends, so a stopped thread has none). Past the due time the request is in flight (Claude announces nothing when a retry
 * goes through; the next frame clears it), so the note says "retrying now".
 */
export function retryNote(i: RetryNoteInput): string | null {
  if (!i.retry) return null;
  const r = i.retry;
  const attempt = r.maxRetries > 0 ? ` (attempt ${String(r.attempt)} of ${String(r.maxRetries)})` : ` (attempt ${String(r.attempt)})`;
  const left = r.retryAtMs - i.nowMs;
  const when = left > 0 ? `retrying in ${fmtRetryIn(left)}` : "retrying now";
  return `${retryCause(r)} · ${when}${attempt}`;
}
