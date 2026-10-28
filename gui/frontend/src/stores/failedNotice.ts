/**
 * The thread composer's failed-prompt notice state (docs/notes/composer-failed-notice.md):
 * the rule's answer for a thread (lib/failedPrompt), minus the prompts a send made stale.
 */
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { failedPrompt } from "@/lib/failedPrompt";
import { useThreadStore } from "./thread";
import { useThreadsStore } from "./threads";

/**
 * Sends begun from this window, by thread: the log's highest ordinal when the send began.
 * A failed prompt at or before it is hidden (the message being sent supersedes it, even
 * before its item arrives); a send that fails drops its hold, so the notice comes back.
 */
const useHolds = create<{ holds: Readonly<Record<string, number>> }>()(() => ({ holds: {} }));

/** Hides the thread's current failed prompt for a send that is beginning; call the returned function if the send fails. */
export function holdFailedNotice(threadId: string): () => void {
  const log = useThreadStore.getState().logs[threadId];
  let top = -1;
  if (log) for (const id of log.order) top = Math.max(top, log.byId[id]?.ordinal ?? -1);
  useHolds.setState((s) => ({ holds: { ...s.holds, [threadId]: Math.max(top, s.holds[threadId] ?? -1) } }));
  return () => {
    useHolds.setState((s) => {
      if (s.holds[threadId] !== top) return s;
      const { [threadId]: _released, ...rest } = s.holds;
      return { holds: rest };
    });
  };
}

/**
 * The prompt the thread's composer offers to send again (its item id and the notice's
 * line), or null: lib/failedPrompt's rule over the thread's log and status, unless a send
 * from this window has superseded it. Narrow: re-renders only when the answer changes.
 */
export function useFailedPrompt(threadId: string, pending: number): { itemId: string; line: string } | null {
  const state = useThreadsStore((s) => s.byId[threadId]?.state ?? "unknown");
  const status = useThreadsStore((s) => s.byId[threadId]?.status ?? "unknown");
  const statusReason = useThreadsStore((s) => s.byId[threadId]?.statusReason ?? "");
  const statusChangedAtMs = useThreadsStore((s) => s.byId[threadId]?.statusChangedAtMs ?? null);
  const transcriptMissing = useThreadsStore((s) => s.byId[threadId]?.transcriptMissing === true);
  const hold = useHolds((s) => s.holds[threadId] ?? -1);
  return useThreadStore(
    useShallow((s) => {
      const log = s.logs[threadId];
      if (!log) return null;
      const f = failedPrompt({ order: log.order, byId: log.byId, state, status, statusReason, statusChangedAtMs, pending, transcriptMissing });
      return f && f.ordinal > hold ? { itemId: f.itemId, line: f.line } : null;
    }),
  );
}
