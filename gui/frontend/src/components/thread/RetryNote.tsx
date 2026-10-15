import { useCallback, useSyncExternalStore } from "react";
import { RETRY_RECHECK_MS, retryNote } from "@/lib/retryNote";
import { useSessionsStore } from "@/stores/sessions";

/** The clock in whole seconds (the countdown's resolution), read at render. */
function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * The composer's amber "Rate limited · retrying in 20 s (attempt 3 of 10)" line above the
 * prompt (docs/notes/api-retry-note.md; the rule is retryNote). Claude Code retries
 * failed API requests itself and says nothing when one goes through, so the line follows
 * the session's retry field: set by an api_retry frame, cleared by the next frame of any
 * other kind. The clock ticks every RETRY_RECHECK_MS only while a retry is pending.
 */
export function RetryNote({ sessionId }: { sessionId: string }) {
  const retry = useSessionsStore((s) => s.byId[sessionId]?.retry ?? null);
  const ticking = retry !== null;
  const subscribe = useCallback(
    (onTick: () => void) => {
      if (!ticking) return () => {};
      const id = window.setInterval(onTick, RETRY_RECHECK_MS);
      return () => {
        window.clearInterval(id);
      };
    },
    [ticking],
  );
  const seconds = useSyncExternalStore(subscribe, nowSeconds, nowSeconds);
  const note = retryNote({ retry, nowMs: seconds * 1000 });
  if (!note) return null;
  return (
    <p className="col-span-2 px-4 pt-2.5 text-xs text-warning" role="status" data-testid="thread-retry">
      {note}
    </p>
  );
}
