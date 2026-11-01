import { describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { isWaiting, waitingCount, waitingOnNames, waitingParts, waitingText } from "./waiting";

function thread(id: string, over: Partial<ThreadView> = {}): ThreadView {
  return { id, name: id, state: "connected", status: "idle", statusReason: "at prompt", createdBy: "", archivedAtMs: null, ...over } as unknown as ThreadView;
}

describe("isWaiting / waitingCount", () => {
  it.each<[string, ThreadView["status"], string, boolean, number]>([
    ["two children", "idle", "waiting on 2 child threads", true, 2],
    ["one child", "idle", "waiting on 1 child thread", true, 1],
    ["children and a subagent", "idle", "waiting on 2 child threads and 1 subagent", true, 2],
    ["every part", "idle", "waiting on 1 child thread and 2 subagents and 3 shells", true, 1],
    ["a subagent alone: no child", "idle", "waiting on 1 subagent", true, 0],
    ["shells alone: no child", "idle", "waiting on 2 shells", true, 0],
    ["a queued wake alone", "idle", "waiting", true, 0],
    ["at its prompt", "idle", "at prompt", false, 0],
    ["a finished turn", "attention", "finished", false, 0],
    ["the reason on another status", "attention", "waiting on 2 child threads", false, 0],
    ["a lookalike", "idle", "waitingroom", false, 0],
  ])("%s", (_name, status, statusReason, waiting, n) => {
    expect(isWaiting({ status, statusReason })).toBe(waiting);
    expect(waitingCount({ status, statusReason })).toBe(n);
  });
  it("is false for an unknown thread", () => {
    expect(isWaiting(undefined)).toBe(false);
  });
});

describe("waitingParts", () => {
  it.each<[string, { children: number; subagents: number; shells: number }]>([
    ["waiting on 2 child threads", { children: 2, subagents: 0, shells: 0 }],
    ["waiting on 1 child thread", { children: 1, subagents: 0, shells: 0 }],
    ["waiting on 2 child threads and 1 subagent", { children: 2, subagents: 1, shells: 0 }],
    ["waiting on 1 child thread and 3 subagents and 2 shells", { children: 1, subagents: 3, shells: 2 }],
    ["waiting on 1 subagent and 1 shell", { children: 0, subagents: 1, shells: 1 }],
    ["waiting on 4 subagents", { children: 0, subagents: 4, shells: 0 }],
    ["waiting on 1 shell", { children: 0, subagents: 0, shells: 1 }],
    ["waiting", { children: 0, subagents: 0, shells: 0 }],
    ["at prompt", { children: 0, subagents: 0, shells: 0 }],
    ["waiting on 2 goats and 1 subagent", { children: 0, subagents: 1, shells: 0 }],
  ])("%s", (reason, want) => {
    expect(waitingParts(reason)).toEqual(want);
  });
});

describe("waitingText", () => {
  it.each<[{ children: number; subagents: number; shells: number }, string]>([
    [{ children: 2, subagents: 0, shells: 0 }, "Waiting on 2 child threads"],
    [{ children: 1, subagents: 0, shells: 0 }, "Waiting on 1 child thread"],
    [{ children: 2, subagents: 1, shells: 0 }, "Waiting on 2 child threads and 1 subagent"],
    [{ children: 1, subagents: 2, shells: 3 }, "Waiting on 1 child thread and 2 subagents and 3 shells"],
    [{ children: 0, subagents: 0, shells: 1 }, "Waiting on 1 shell"],
    [{ children: 0, subagents: 0, shells: 0 }, "Waiting on a wake"],
  ])("%j", (p, text) => {
    expect(waitingText(p)).toBe(text);
  });
});

describe("waitingOnNames", () => {
  const data = (threads: ThreadView[]) => ({ byId: Object.fromEntries(threads.map((t) => [t.id, t])), order: threads.map((t) => t.id) });
  it("lists the working or waiting children in spawn order, not settled, archived or other threads' ones", () => {
    const d = data([
      thread("lead", { statusReason: "waiting on 3 child threads" }),
      thread("c1", { createdBy: "lead", status: "busy", statusReason: "working" }),
      thread("c2", { createdBy: "lead", status: "attention", statusReason: "finished" }),
      thread("c3", { createdBy: "lead", statusReason: "waiting on 1 child thread", name: "" }),
      thread("c4", { createdBy: "lead", status: "busy", archivedAtMs: 5 }),
      thread("c5", { createdBy: "other", status: "busy" }),
      thread("c6", { createdBy: "lead", state: "starting", status: "unknown" }),
    ]);
    expect(waitingOnNames(d, "lead")).toEqual({ names: ["c1", "c3", "c6"], more: 0 });
  });
  it("caps the names and counts the rest", () => {
    const kids = Array.from({ length: 7 }, (_, i) => thread(`k${String(i)}`, { createdBy: "lead", status: "busy" }));
    expect(waitingOnNames(data([thread("lead"), ...kids]), "lead")).toEqual({ names: ["k0", "k1", "k2", "k3", "k4"], more: 2 });
  });
});
