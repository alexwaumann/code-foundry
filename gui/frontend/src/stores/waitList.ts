/**
 * The waiting strip's data and its actions (docs/notes/waiting-strip.md). The list lives on
 * the thread store's log (`ThreadLog.wakes`, fed by the thread's Watch, open whenever the
 * thread is selected); an unchanged list keeps its identity, so only a change re-renders.
 * Every action is a registry command.
 */
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { isNotFound } from "@/api/errors";
import type { BackgroundShellView } from "@/api/threads";
import type { WakeSubscriptionView } from "@/api/wakes";
import { runCommandForResult } from "./commands";
import { useThreadStore } from "./thread";
import { threadContext } from "./threadActions";
import { useThreadsStore } from "./threads";

const NO_WAKES: readonly WakeSubscriptionView[] = [];

/**
 * Whether what the strip would show is current: this Watch delivered its snapshot, and it
 * is not failing. A closed Watch leaves its log behind for the next visit, so without this
 * a thread shows the rows it had when it was left, and Stop waiting acts on them. Connecting
 * with a snapshot in hand is a resync: the rows stand until the new snapshot replaces them.
 */
export function useWaitListCurrent(threadId: string): boolean {
  return useThreadStore((s) => {
    const status = s.watches[threadId]?.status;
    return threadId in s.synced && status !== "retrying" && status !== "stopped";
  });
}

/** The thread's wake subscriptions, as its Watch last said ([] before the first snapshot). */
export function useWakes(threadId: string): readonly WakeSubscriptionView[] {
  return useThreadStore((s) => s.logs[threadId]?.wakes ?? NO_WAKES);
}

/** The thread's running background shells, encoded so a thread update that leaves them alone re-renders nothing. An archived thread has none. */
export function useWaitShells(threadId: string): readonly BackgroundShellView[] {
  const encoded = useThreadsStore(
    useShallow((s) => {
      const t = s.byId[threadId];
      return t && t.archivedAtMs === null ? t.backgroundShells.map((b) => JSON.stringify(b)) : [];
    }),
  );
  return useMemo(() => encoded.map((s) => JSON.parse(s) as BackgroundShellView), [encoded]);
}

/**
 * thread.unsubscribe: the row's ×. Quiet: the row leaves when the list says so. NotFound
 * is no failure: the wake went by itself just as it was pressed, which is what was asked.
 */
export async function removeWake(threadId: string, subscription: string): Promise<boolean> {
  const failure = { gone: false };
  const res = await runCommandForResult("thread.unsubscribe", { subscription }, { ctx: threadContext(threadId), quiet: true, expected: (err) => (failure.gone = isNotFound(err)) });
  return res !== null || failure.gone;
}

/** thread.stop-waiting: the daemon asks first when shells would stop. Quiet: the strip shows the result. */
export async function stopWaiting(threadId: string): Promise<boolean> {
  return (await runCommandForResult("thread.stop-waiting", { id: threadId }, { ctx: threadContext(threadId), quiet: true })) !== null;
}
