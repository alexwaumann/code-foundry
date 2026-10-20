import { describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { emberAttentionId, emberThreadOf } from "./ember";
import { emptyThreads, replaceThreads } from "./threads";

function thread(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return { id, createdAtMs: 10, status: "idle", state: "connected", archivedAtMs: null, snoozedUntilMs: null, flags: [], usage: [], ...over } as ThreadView;
}

describe("Ember's thread", () => {
  const mine = thread("s-mine", { status: "attention" });
  const scout = thread("s-scout", { resident: "scout", epoch: 1, status: "attention" });

  it("is the resident named ember", () => {
    expect(emberThreadOf(replaceThreads(emptyThreads, [mine, scout]))).toBe("");
    expect(emberThreadOf(replaceThreads(emptyThreads, [mine, scout, thread("s-ember", { resident: "ember", epoch: 2 })]))).toBe("s-ember");
  });

  it.each([
    ["needs attention, Ember on", "attention", true, "s-ember"],
    ["needs attention, Ember off", "attention", false, ""],
    ["idle", "idle", true, ""],
    ["busy", "busy", true, ""],
  ] as const)("counts for the bell when it %s", (_n, status, enabled, want) => {
    const d = replaceThreads(emptyThreads, [mine, scout, thread("s-ember", { resident: "ember", epoch: 2, status })]);
    expect(emberAttentionId(d, enabled)).toBe(want);
  });
});
