/**
 * What the pill above the composer (ComposerRow, docs/notes/composer-row-pill.md) reads about its
 * thread: its snooze, what it waits on, and Stop waiting. The stores the old waiting and snooze
 * bars read; nothing here opens a stream.
 */
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { PillSnooze } from "@/lib/composerPill";
import { isSnoozed } from "@/lib/snooze";
import { statusLine } from "@/lib/statusLine";
import { waitCounts, type WaitCounts } from "@/lib/waitList";
import { useStripRunIds } from "@/stores/agents";
import { useThreadsStore } from "@/stores/threads";
import { stopWaiting, useWaitListCurrent, useWaitListShown, useWaitShells, useWakes } from "@/stores/waitList";

type SnoozeKey =
  | { kind: "snoozed"; until: number }
  | { kind: "saved" }
  | { kind: "event"; eventKind: "pull_request" | "plugin"; waitingFor: string }
  | { kind: "woken"; at: number; by: string }
  | { kind: "none" };

/**
 * The thread's snooze as the pill shows it: snoozed until a time, saved for later, woken
 * (docs/notes/clear-woken-thread.md), or null. Saved wins over a time, as the sidebar reads it.
 */
export function usePillSnooze(threadId: string): PillSnooze | null {
  const k = useThreadsStore(
    useShallow((s): SnoozeKey => {
      const t = s.byId[threadId];
      if (!t) return { kind: "none" };
      // An event's snooze is a save with an event that ends it (docs/notes/snooze-until-event.md).
      if (t.snoozeEvent) return { kind: "event", eventKind: t.snoozeEvent.kind, waitingFor: t.snoozeEvent.waitingFor };
      if (t.savedAtMs !== null) return { kind: "saved" };
      if (isSnoozed(t) && t.snoozedUntilMs !== null) return { kind: "snoozed", until: t.snoozedUntilMs };
      const l = statusLine(t);
      return l.kind === "snoozeEnded" ? { kind: "woken", at: l.at ?? 0, by: t.snoozeEndedBy ?? "" } : { kind: "none" };
    }),
  );
  if (k.kind === "none") return null;
  if (k.kind === "woken") return { kind: "woken", at: k.at === 0 ? null : k.at, ...(k.by ? { by: k.by } : {}) };
  return k;
}

/** What the waiting segment and its panel are drawn from (useWaitData). */
export interface WaitData {
  /** Anything to show: the thread is live, the Watch is not failing, and something will wake it. */
  shown: boolean;
  counts: WaitCounts;
  /** Stop waiting can do something: a subscription or a shell (a subagent cannot be stopped). */
  canStop: boolean;
}

/**
 * What will wake this thread without the user, whatever its status says
 * (docs/notes/waiting-strip.md): its subscriptions, background shells and background
 * subagents. On a return to a thread it is there at once with what the thread waited on
 * when it was left, so the row does not change under the conversation a moment later; the
 * stop controls wait for the Watch to say what is current (useWaitListCurrent). Nothing shows
 * while the Watch is failing (useWaitListShown).
 */
export function useWaitData(threadId: string): WaitData {
  const wakes = useWakes(threadId);
  const shells = useWaitShells(threadId);
  const runs = useStripRunIds(threadId);
  const live = useThreadsStore((s) => s.byId[threadId]?.archivedAtMs === null);
  const shown = useWaitListShown(threadId);
  const counts = useMemo(() => waitCounts(wakes, shells.length, runs.length), [wakes, shells.length, runs.length]);
  return { shown: live && shown && wakes.length + shells.length + runs.length > 0, counts, canStop: wakes.length + shells.length > 0 };
}

/**
 * Stop waiting: thread.stop-waiting, which asks its own question (ConfirmationRequired); held
 * while it runs and until the Watch says what is current. The pill's own segment (idle) and the
 * panel's "Stop waiting on all".
 */
export function useStopWaiting(threadId: string): { stop: () => void; disabled: boolean } {
  const current = useWaitListCurrent(threadId);
  const [stopping, setStopping] = useState(false);
  return {
    disabled: stopping || !current,
    stop: () => {
      setStopping(true);
      void stopWaiting(threadId).finally(() => {
        setStopping(false);
      });
    },
  };
}
