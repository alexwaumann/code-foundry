// @vitest-environment node
import { describe, expect, it } from "vitest";
import type { UiContext } from "../src/gen/codefoundry/v1/command_pb";
import { ThreadStatus } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
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
});
