import { useEffect, useState } from "react";
import { COLD_CACHE_RECHECK_MS, coldCacheNote } from "@/lib/coldCache";
import { useDraft } from "@/stores/compose";
import { useThreadsStore } from "@/stores/threads";
import { threadDraftKey } from "@/stores/threadActions";

/**
 * The composer's muted "Cache expired" line above the prompt
 * (docs/notes/rendered-threads-cold-cache.md; the rule is coldCacheNote). It re-checks the
 * clock every COLD_CACHE_RECHECK_MS while mounted, so the line appears while the user is
 * looking; only this line re-renders. The clock may lag by one tick, which can only delay
 * the line (a new result's expiry is in the future), never show it early.
 */
export function ColdCacheNote({ threadId, pending }: { threadId: string; pending: number }) {
  const phase = useDraft(threadDraftKey(threadId), "phase");
  const state = useThreadsStore((s) => s.byId[threadId]?.state ?? "unknown");
  const status = useThreadsStore((s) => s.byId[threadId]?.status ?? "unknown");
  const contextTokens = useThreadsStore((s) => s.byId[threadId]?.contextTokens ?? 0);
  const cacheExpiresAtMs = useThreadsStore((s) => s.byId[threadId]?.cacheExpiresAtMs ?? null);
  const contextRereadUsd = useThreadsStore((s) => s.byId[threadId]?.contextRereadUsd ?? 0);
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => {
      setNowMs(Date.now());
    }, COLD_CACHE_RECHECK_MS);
    return () => {
      window.clearInterval(id);
    };
  }, []);
  const note = coldCacheNote({ state, status, contextTokens, cacheExpiresAtMs, contextRereadUsd, pending, phase, nowMs });
  if (!note) return null;
  return (
    <p className="col-span-2 px-4 pt-2.5 text-caption" role="status" data-testid="thread-cold-cache">
      {note}
    </p>
  );
}
