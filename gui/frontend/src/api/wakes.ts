/**
 * A thread's wake subscriptions (docs/notes/wait-list-daemon.md) mapped to view models.
 * Generated types stay in src/api. ThreadService.WatchThread carries the whole list: the
 * snapshot's `subscriptions`, then a `subscriptions` event on every change, so the waiting
 * strip above the composer reads it from the thread store.
 */
import { ThreadSubscriptionCondition, ThreadSubscriptionTarget, type ThreadSubscription } from "@/gen/codefoundry/v1/thread_subscriptions_pb";

export type WakeKind = "thread" | "pullRequest" | "actionRun" | "plugin" | "timer";

/** One wake subscription of the thread: something that will wake it without the user. */
export interface WakeSubscriptionView {
  /** "sub-…": thread.unsubscribe takes it. */
  id: string;
  kind: WakeKind;
  /** A thread id, a run id, "owner/name#123", "<plugin>/<source>" or the timer's spec. */
  targetId: string;
  /** "owner/name#123 Title", an action's name, "every 30m"; "" when unnamed or gone. */
  targetName: string;
  /** The target's state in words when the list was read ("open · checks pending (2/4)", "next 15:30"). */
  targetStatus: string;
  /** What fires it, in words: "settled", "checks failed", "merged". */
  condition: string;
  /** Why it was asked for; "" for none. */
  note: string;
}

const kinds: Record<ThreadSubscriptionTarget, WakeKind> = {
  [ThreadSubscriptionTarget.UNSPECIFIED]: "plugin",
  [ThreadSubscriptionTarget.THREAD]: "thread",
  [ThreadSubscriptionTarget.ACTION_RUN]: "actionRun",
  [ThreadSubscriptionTarget.PULL_REQUEST]: "pullRequest",
  [ThreadSubscriptionTarget.PLUGIN]: "plugin",
  [ThreadSubscriptionTarget.TIMER]: "timer",
};

const conditions: Record<ThreadSubscriptionCondition, string> = {
  [ThreadSubscriptionCondition.UNSPECIFIED]: "",
  [ThreadSubscriptionCondition.SETTLED]: "settled",
  [ThreadSubscriptionCondition.IDLE]: "idle",
  [ThreadSubscriptionCondition.ATTENTION]: "needs attention",
  [ThreadSubscriptionCondition.ERROR]: "error",
  [ThreadSubscriptionCondition.DISCONNECTED]: "disconnected",
  [ThreadSubscriptionCondition.FINISHED]: "finished",
  [ThreadSubscriptionCondition.CHECKS_DONE]: "checks done",
  [ThreadSubscriptionCondition.CHECKS_FAILED]: "checks failed",
  [ThreadSubscriptionCondition.CHECKS_PASSED]: "checks passed",
  [ThreadSubscriptionCondition.REVIEW]: "review",
  [ThreadSubscriptionCondition.COMMENT]: "comment",
  [ThreadSubscriptionCondition.REVIEW_REQUESTED]: "review requested",
  [ThreadSubscriptionCondition.HEAD_PUSHED]: "pushed",
  [ThreadSubscriptionCondition.MERGED]: "merged",
  [ThreadSubscriptionCondition.CLOSED]: "closed",
  [ThreadSubscriptionCondition.CHANGED]: "changed",
  [ThreadSubscriptionCondition.FIRED]: "fired",
};

export function toWakeSubscriptionView(s: ThreadSubscription): WakeSubscriptionView {
  return {
    id: s.id,
    kind: kinds[s.target],
    targetId: s.targetId,
    targetName: s.targetName,
    targetStatus: s.targetStatus,
    condition: conditions[s.condition],
    note: s.note,
  };
}

export const toWakeViews = (subs: readonly ThreadSubscription[]): WakeSubscriptionView[] => subs.map(toWakeSubscriptionView);
