// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { ThreadStatus } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import { ThreadRequestState } from "../src/gen/codefoundry/v1/thread_pb";
import { PASSUP_QUESTION, PASSUP_REQUEST, PASSUP_WORKER } from "./passUp";
import { World } from "./world";

/** The worker card's passup scenario (docs/notes/pass-up-question.md) and the mock's answer to it. */
describe("a passed-up question in the mock", () => {
  it("the lead asks it in Needs you, and thread.respond answers it as the daemon does", async () => {
    const w = new World();
    const lead = w.addWorkerCard("passup");
    const s = w.threads.get(lead);
    expect(s?.status).toBe(ThreadStatus.NEEDS_ATTENTION);
    expect(s?.statusReason).toBe(`question: From ${PASSUP_WORKER.name}: ${PASSUP_QUESTION}`);
    const snap = w.logs.snapshotValue(lead);
    expect(snap.pending).toMatchObject([{ requestId: PASSUP_REQUEST, fromThreadId: PASSUP_WORKER.id, question: true }]);
    const item = snap.items.find((x) => x.payload?.case === "question");
    expect(item?.payload?.case === "question" && item.payload.value.passedUp).toMatchObject({ fromThreadId: PASSUP_WORKER.id, threadAsk: true, assuming: "only the gutters" });

    await w.invoke("thread.respond", { activeThreadId: lead } as UiContext, { id: lead, request: PASSUP_REQUEST, decision: "allow", answer: JSON.stringify({ [PASSUP_QUESTION]: "The body too" }) });
    expect(w.logs.snapshotValue(lead).pending).toEqual([]);
    expect(w.threads.get(lead)?.statusReason).toBe("at prompt");
    expect(w.logs.calls).toContain(`pass-up answered ${PASSUP_WORKER.id} {"${PASSUP_QUESTION}":"The body too"}`);
  });

  it("passup-working: the lead works on under it; an interrupt stops the turn and keeps the question", async () => {
    const w = new World();
    const lead = w.addWorkerCard("passup-working");
    const reason = `question: From ${PASSUP_WORKER.name}: ${PASSUP_QUESTION}`;
    expect(w.threads.get(lead)).toMatchObject({ status: ThreadStatus.NEEDS_ATTENTION, statusReason: reason, busyUnderPassUp: true });

    await w.invoke("thread.interrupt", { activeThreadId: lead } as UiContext, { id: lead });
    expect(w.threads.get(lead)).toMatchObject({ status: ThreadStatus.NEEDS_ATTENTION, statusReason: reason, busyUnderPassUp: false });
    expect(w.logs.snapshotValue(lead).pending).toMatchObject([{ requestId: PASSUP_REQUEST, fromThreadId: PASSUP_WORKER.id }]);
    const items = w.logs.snapshotValue(lead).items;
    expect(items.at(-1)?.payload).toMatchObject({ case: "turnEnd", value: { interrupted: true } });
    const q = items.find((x) => x.payload?.case === "question");
    expect(q?.payload?.case === "question" && q.payload.value.state).toBe(ThreadRequestState.PENDING);

    await w.invoke("thread.respond", { activeThreadId: lead } as UiContext, { id: lead, request: PASSUP_REQUEST, decision: "allow", answer: JSON.stringify({ [PASSUP_QUESTION]: "The body too" }) });
    expect(w.threads.get(lead)).toMatchObject({ busyUnderPassUp: false });
    expect(w.threads.get(lead)?.statusReason).not.toBe(reason);
  });

  it("passup-working again after an interrupt and a reset: working again", async () => {
    const w = new World();
    const lead = w.addWorkerCard("passup-working");
    await w.invoke("thread.interrupt", { activeThreadId: lead } as UiContext, { id: lead });
    w.reset();
    expect(w.threads.get(w.addWorkerCard("passup-working"))).toMatchObject({ busyUnderPassUp: true });
    await w.invoke("thread.interrupt", { activeThreadId: lead } as UiContext, { id: lead });
    expect(w.threads.get(w.addWorkerCard("passup-working"))).toMatchObject({ busyUnderPassUp: true });
  });
});
