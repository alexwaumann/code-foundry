import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { MessageDelivery, ThreadEventSchema } from "@/gen/codefoundry/v1/thread_pb";
import { applyThreadEvent } from "@/stores/thread";
import { toThreadEventView, type ThreadEventView } from "./thread";

// A message the user cancelled or sent again leaves the thread: the daemon says so once, in
// the update that drops it (delivery CANCELLED; docs/notes/cancel-queued-messages.md).

const msg = (id: string, delivery: MessageDelivery) => ({ id, ordinal: 2n, payload: { case: "userMessage" as const, value: { text: "hi", delivery } } });
const ev = (e: object) => toThreadEventView(create(ThreadEventSchema, { event: e } as never)) as ThreadEventView;

describe("a cancelled message", () => {
  it("an update saying CANCELLED is the message's removal", () => {
    expect(ev({ case: "updated", value: { threadId: "s", seq: 5n, item: msg("u2", MessageDelivery.CANCELLED) } })).toEqual({ kind: "removed", threadId: "s", seq: 5, itemId: "u2" });
  });

  it("a snapshot never shows one", () => {
    const snap = ev({ case: "snapshot", value: { threadId: "s", seq: 3n, items: [msg("u1", MessageDelivery.UNSPECIFIED), msg("u2", MessageDelivery.CANCELLED)] } });
    expect(snap.kind === "snapshot" && snap.items.map((x) => x.id)).toEqual(["u1"]);
  });

  it("the log drops it (byId and order), and moves its seq on; an unknown one only moves the seq", () => {
    const log = applyThreadEvent(undefined, ev({ case: "snapshot", value: { threadId: "s", seq: 3n, items: [msg("u1", MessageDelivery.UNSPECIFIED), { ...msg("u2", MessageDelivery.QUEUED), ordinal: 4n }] } }));
    expect(log?.order).toEqual(["u1", "u2"]);
    const next = applyThreadEvent(log, { kind: "removed", threadId: "s", seq: 4, itemId: "u2" });
    expect(next?.order).toEqual(["u1"]);
    expect(next?.byId.u2).toBeUndefined();
    expect(next?.seq).toBe(4);
    const again = applyThreadEvent(next, { kind: "removed", threadId: "s", seq: 5, itemId: "u2" });
    expect(again?.order).toBe(next?.order);
    expect(again?.seq).toBe(5);
    // An old event (its seq included already) changes nothing.
    expect(applyThreadEvent(next, { kind: "removed", threadId: "s", seq: 4, itemId: "u1" })).toBe(next);
  });
});
