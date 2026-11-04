import { create } from "@bufbuild/protobuf";
import { describe, expect, it } from "vitest";
import { ThreadEventSchema, ThreadItemsSnapshotSchema } from "@/gen/codefoundry/v1/thread_pb";
import { ThreadSubscriptionCondition, ThreadSubscriptionSchema, ThreadSubscriptionsChangeSchema, ThreadSubscriptionTarget } from "@/gen/codefoundry/v1/thread_subscriptions_pb";
import { toThreadEventView } from "./thread";
import { toWakeSubscriptionView } from "./wakes";

const sub = (o: Parameters<typeof create<typeof ThreadSubscriptionSchema>>[1]) => create(ThreadSubscriptionSchema, o);

describe("toWakeSubscriptionView", () => {
  it.each([
    [ThreadSubscriptionTarget.THREAD, ThreadSubscriptionCondition.SETTLED, "thread", "settled"],
    [ThreadSubscriptionTarget.PULL_REQUEST, ThreadSubscriptionCondition.CHECKS_FAILED, "pullRequest", "checks failed"],
    [ThreadSubscriptionTarget.ACTION_RUN, ThreadSubscriptionCondition.FINISHED, "actionRun", "finished"],
    [ThreadSubscriptionTarget.PLUGIN, ThreadSubscriptionCondition.FIRED, "plugin", "fired"],
    [ThreadSubscriptionTarget.TIMER, ThreadSubscriptionCondition.FIRED, "timer", "fired"],
  ])("target %i", (target, condition, kind, words) => {
    const v = toWakeSubscriptionView(sub({ id: "sub-1", target, condition, targetId: "x", targetName: "X", targetStatus: "next 09:30", note: "why" }));
    expect(v).toEqual({ id: "sub-1", kind, targetId: "x", targetName: "X", targetStatus: "next 09:30", condition: words, note: "why" });
  });
});

describe("the stream", () => {
  it("a snapshot and a change both carry the whole list", () => {
    const subscriptions = [sub({ id: "sub-1", target: ThreadSubscriptionTarget.TIMER })];
    const snapshot = create(ThreadEventSchema, { event: { case: "snapshot", value: create(ThreadItemsSnapshotSchema, { threadId: "s", subscriptions }) } });
    const change = create(ThreadEventSchema, { event: { case: "subscriptions", value: create(ThreadSubscriptionsChangeSchema, { threadId: "s", subscriptions }) } });
    expect(toThreadEventView(snapshot)).toMatchObject({ kind: "snapshot", wakes: [{ id: "sub-1", kind: "timer" }] });
    expect(toThreadEventView(change)).toEqual({ kind: "wakes", threadId: "s", wakes: [expect.objectContaining({ id: "sub-1" })] });
  });
});
