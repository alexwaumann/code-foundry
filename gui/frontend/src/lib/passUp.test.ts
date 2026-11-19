import { describe, expect, it } from "vitest";
import { askerName, askTitle, passedUpLine, withPassedUp } from "./passUp";
import type { WorkerNow } from "./workerRuns";

/** A worker's question passed up to the user (docs/notes/pass-up-question.md): the cards' words and the worker card's line state. */
describe("the passed-up question's words", () => {
  it.each([
    ["the lead's own", null, 1, "Claude has a question"],
    ["the lead's own, several", null, 2, "Claude has 2 questions"],
    ["a worker's", "Resize", 1, "Resize has a question"],
    ["a worker's, several", "Resize", 3, "Resize has 3 questions"],
  ] as const)("title: %s", (_n, who, n, want) => {
    expect(askTitle(who, n)).toBe(want);
  });

  it("the line: who passed it up, and a thread ask's assumption", () => {
    expect(passedUpLine({ threadAsk: false, assuming: "" })).toBe("Passed up by this thread.");
    expect(passedUpLine(undefined)).toBe("Passed up by this thread.");
    expect(passedUpLine({ threadAsk: true, assuming: " only the\n gutters. " })).toBe("Passed up by this thread. Until you answer, it assumes: only the gutters.");
    expect(passedUpLine({ threadAsk: true, assuming: "" })).toBe("Passed up by this thread.");
  });

  it("the worker's name: now, else when passed up, else its id", () => {
    expect(askerName("s-w", "Resize panes", "Resize")).toBe("Resize panes");
    expect(askerName("s-w", undefined, "Resize")).toBe("Resize");
    expect(askerName("s-w", "", "")).toBe("s-w");
  });
});

describe("withPassedUp", () => {
  const w = (id: string, state: WorkerNow["state"]): WorkerNow => ({ id, createdAtMs: 1, state, sinceMs: 2 });
  const workers = new Map([w("a", "working"), w("b", "finished"), w("c", "archived")].map((x) => [x.id, x]));

  it("nothing passed up: the same map", () => {
    expect(withPassedUp(workers, "")).toBe(workers);
  });

  it("a worker whose question is passed up reads asks you; others and an archived one stay", () => {
    const out = withPassedUp(workers, "a\nc\nnot-a-worker");
    expect([...out.values()].map((x) => `${x.id} ${x.state}`)).toEqual(["a asks", "b finished", "c archived"]);
    expect(out.get("a")?.sinceMs).toBe(2);
    expect(workers.get("a")?.state).toBe("working");
  });

  it("once answered (no longer listed) it returns to its own state", () => {
    expect(withPassedUp(workers, "").get("a")?.state).toBe("working");
  });
});
