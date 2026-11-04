/**
 * A thread's wake subscriptions in the mock daemon (docs/notes/wait-list-daemon.md): the
 * list ListSubscriptions answers and WatchThread carries, thread.unsubscribe's rows and
 * thread.stop-waiting.
 *
 *   POST /__mock/thread?state=waiting   idle at its prompt with two thread targets, a pull
 *        request, a timer, a background shell and a background subagent
 *   POST /__mock/thread/wake-fire?id=s-r1&sub=sub-pr   a one-shot fires: its row goes
 *   POST /__mock/thread/wake-status?id=s-r1&sub=sub-pr&status=…   a target's status changes
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ThreadSubscriptionCondition, ThreadSubscriptionTarget, type ThreadSubscriptionSchema } from "../src/gen/codefoundry/v1/thread_subscriptions_pb";
import { backgroundRun } from "./liveCount";
import type { AgentRunInit, AgentsScript } from "./agents";
import { launchShell, type ShellCall } from "./shells";

export type WakeInit = MessageInitShape<typeof ThreadSubscriptionSchema>;

/** The "waiting" state's subscriptions of thread `id`. s-1 and s-2 are real mock threads, so their rows read live. */
export function sampleWakes(id: string): WakeInit[] {
  const sub = (o: WakeInit): WakeInit => ({ subscriberThreadId: id, ...o });
  return [
    sub({ id: "sub-t1", target: ThreadSubscriptionTarget.THREAD, targetId: "s-1", condition: ThreadSubscriptionCondition.SETTLED, repeat: true, targetName: "Refactor sidebar tree", targetStatus: "busy (working)" }),
    sub({ id: "sub-t2", target: ThreadSubscriptionTarget.THREAD, targetId: "s-2", condition: ThreadSubscriptionCondition.SETTLED, repeat: true, targetName: "Port renderer", targetStatus: "needs attention (permission)" }),
    sub({ id: "sub-pr", target: ThreadSubscriptionTarget.PULL_REQUEST, targetId: "acme/api#412", condition: ThreadSubscriptionCondition.CHECKS_DONE, targetName: "acme/api#412 Rotate tokens", targetStatus: "open · checks pending (2/4)" }),
    sub({ id: "sub-timer", target: ThreadSubscriptionTarget.TIMER, targetId: "at:2026-11-04T21:30:00Z", condition: ThreadSubscriptionCondition.FIRED, targetName: "at 15:30", targetStatus: "next 15:30", note: "Check the deploy" }),
  ];
}

/** The "waiting" state's conversation: it left a dev server and a review running, and ended its turn. */
export function scriptWaiting(s: AgentsScript, now = Date.now()): { shells: ShellCall[]; runs: AgentRunInit[] } {
  const ago = (sec: number) => new Date(now - sec * 1000);
  s.it({ case: "userMessage", value: { text: "Start the dev server, have the token PR reviewed and tell me when the rest lands.", attachments: [] } }, { at: ago(95) });
  const shells = [launchShell(s, { taskId: "bdev0server", command: "npm run dev", description: "Start the dev server", at: ago(90) })];
  s.it({ case: "assistantText", value: { text: "The dev server is up. I will pick this up when the threads, the pull request and the deploy check come back." } }, { at: ago(84) });
  s.it({ case: "turnEnd", value: { subtype: "success", durationMs: 11_000n, numTurns: 3, costUsd: 0.03, turnCostUsd: 0.03, model: "claude-opus-4-8", stopReason: "end_turn" } }, { at: ago(83) });
  return { shells, runs: [backgroundRun("a-review", "Review usage_runs changes", "", 2)] };
}
