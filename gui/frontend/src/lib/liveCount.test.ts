import { describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { isLiveChild, liveChildCount, liveCount } from "./liveCount";

function thread(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return {
    id,
    name: id,
    state: "connected",
    status: "idle",
    statusReason: "at prompt",
    createdBy: "",
    archivedAtMs: null,
    snoozedUntilMs: null,
    flags: [],
    backgroundAgentsRunning: 0,
    ...over,
  } as unknown as ThreadView;
}

const data = (threads: ThreadView[]) => ({ byId: Object.fromEntries(threads.map((t) => [t.id, t])), order: threads.map((t) => t.id) });
const kid = (id: string, over: Partial<ThreadView> = {}) => thread(id, { createdBy: "p", ...over });

describe("liveCount", () => {
  it.each<[string, number, ThreadView[], number]>([
    ["nothing", 0, [], 0],
    ["background subagents only", 2, [], 2],
    ["a working child", 0, [kid("a", { status: "busy" })], 1],
    ["a starting child", 0, [kid("a", { state: "starting", status: "unknown" })], 1],
    ["a child asking a question", 0, [kid("a", { status: "attention", statusReason: "question: Which?" })], 1],
    ["a child at a permission prompt", 0, [kid("a", { status: "attention", statusReason: "permission: Bash" })], 1],
    ["a nested lead waiting on its workers", 0, [kid("a", { statusReason: "waiting on 2 child threads" })], 1],
    ["a child waiting on its subagent", 0, [kid("a", { statusReason: "waiting on 1 subagent" })], 1],
    ["a finished child", 0, [kid("a", { status: "attention", statusReason: "finished" })], 0],
    ["an idle child", 0, [kid("a")], 0],
    ["a failed child", 0, [kid("a", { status: "attention", statusReason: "error: overloaded" })], 0],
    ["an archived working child", 0, [kid("a", { status: "busy", archivedAtMs: 5 })], 0],
    ["a snoozed child", 0, [kid("a", { status: "attention", statusReason: "question: Which?", snoozedUntilMs: 9 })], 0],
    ["another thread's child", 0, [thread("a", { createdBy: "q", status: "busy" })], 0],
    ["a grandchild is its parent's, not ours", 0, [kid("a"), thread("g", { createdBy: "a", status: "busy" })], 0],
    [
      "subagents and children together",
      1,
      [kid("a", { status: "busy" }), kid("b", { statusReason: "waiting on 1 child thread" }), kid("c", { status: "attention", statusReason: "finished" }), kid("d", { status: "busy", archivedAtMs: 1 })],
      3,
    ],
  ])("%s", (_name, bg, kids, want) => {
    const d = data([thread("p", { backgroundAgentsRunning: bg }), ...kids]);
    expect(liveCount(d, "p")).toBe(want);
  });

  it("is 0 for an unknown thread or no id", () => {
    const d = data([kid("a", { status: "busy" })]);
    expect(liveCount(d, "p")).toBe(0);
    expect(liveCount(d, "")).toBe(0);
    expect(liveChildCount(d, "")).toBe(0);
  });

  it("re-reads the children when the list changes", () => {
    const p = thread("p");
    const d1 = data([p, kid("a", { status: "busy" })]);
    expect(liveCount(d1, "p")).toBe(1);
    const d2 = data([p, kid("a", { status: "busy" }), kid("b", { status: "busy" })]);
    expect(liveCount(d2, "p")).toBe(2);
    expect(liveCount(d1, "p")).toBe(1);
  });

  it("isLiveChild is false for an unknown thread", () => {
    expect(isLiveChild(undefined)).toBe(false);
  });
});
