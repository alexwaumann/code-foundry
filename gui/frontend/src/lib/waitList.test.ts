import { describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import type { WakeKind, WakeSubscriptionView } from "@/api/wakes";
import { orderWakes, shareWakes, shellName, threadTargetStatus, waitCounts, waitSentence, wakeCondition, wakeName, wakeStatus, wakeTip } from "./waitList";

const wake = (id: string, kind: WakeKind, o: Partial<WakeSubscriptionView> = {}): WakeSubscriptionView => ({
  id,
  kind,
  targetId: id,
  targetName: "",
  targetStatus: "",
  condition: "settled",
  note: "",
  ...o,
});

const NONE = { threads: 0, pullRequests: 0, actionRuns: 0, sources: 0, timers: 0, shells: 0, subagents: 0 };

describe("waitSentence", () => {
  it.each([
    ["one thing", { threads: 1 }, "Waiting on 1 thread"],
    ["two things", { shells: 2, subagents: 1 }, "Waiting on 2 shells and 1 subagent"],
    ["the design's line", { threads: 2, pullRequests: 1, timers: 1, shells: 1, subagents: 1 }, "Waiting on 2 threads, 1 PR, 1 timer, 1 shell and 1 subagent"],
    ["every kind, in order", { threads: 1, pullRequests: 2, actionRuns: 2, sources: 2, timers: 2, shells: 1, subagents: 2 }, "Waiting on 1 thread, 2 PRs, 2 action runs, 2 plugin sources, 2 timers, 1 shell and 2 subagents"],
  ])("%s", (_name, counts, want) => {
    expect(waitSentence({ ...NONE, ...counts })).toBe(want);
  });
});

describe("waitCounts", () => {
  it("counts a target once, however many subscriptions it has", () => {
    const wakes = [wake("a", "pullRequest", { targetId: "o/r#1" }), wake("b", "pullRequest", { targetId: "o/r#1", condition: "review" }), wake("c", "pullRequest", { targetId: "o/r#2" }), wake("d", "thread")];
    expect(waitCounts(wakes, 3, 1)).toEqual({ ...NONE, threads: 1, pullRequests: 2, shells: 3, subagents: 1 });
  });
});

describe("orderWakes", () => {
  it("goes by kind, in the sentence's order, keeping creation order within one", () => {
    const wakes = [wake("t", "timer"), wake("p2", "pullRequest"), wake("th", "thread"), wake("p1", "pullRequest"), wake("pl", "plugin"), wake("r", "actionRun")];
    expect(orderWakes(wakes).map((w) => w.id)).toEqual(["th", "p2", "p1", "r", "pl", "t"]);
  });
});

describe("a row's words", () => {
  it.each([
    ["a timer's reason names it", wake("a", "timer", { note: "Check the deploy", targetName: "at 15:30" }), "Check the deploy", "at 15:30"],
    ["a timer without one", wake("a", "timer", { targetName: "every 30m" }), "every 30m", ""],
    ["another target keeps its name, the reason is the tooltip", wake("a", "pullRequest", { targetName: "o/r#1 Title", note: "Merge after" }), "o/r#1 Title", "Merge after"],
    ["an unnamed target falls back to its id", wake("r-1", "actionRun"), "r-1", ""],
  ])("%s", (_name, w, name, tip) => {
    expect(wakeName(w)).toBe(name);
    expect(wakeTip(w)).toBe(tip);
  });

  it("drops a pull request's open, and nothing else's", () => {
    expect(wakeStatus(wake("a", "pullRequest", { targetStatus: "open · checks pending (2/4) · review required" }))).toBe("checks pending (2/4) · review required");
    expect(wakeStatus(wake("a", "pullRequest", { targetStatus: "merged" }))).toBe("merged");
    expect(wakeStatus(wake("a", "plugin", { targetStatus: "open · x" }))).toBe("open · x");
  });

  it("names the condition only where two subscriptions share a target", () => {
    const a = wake("a", "pullRequest", { targetId: "o/r#1", condition: "review" });
    const b = wake("b", "pullRequest", { targetId: "o/r#1", condition: "merged" });
    const c = wake("c", "pullRequest", { targetId: "o/r#2" });
    expect([a, b, c].map((w) => wakeCondition([a, b, c], w))).toEqual(["review", "merged", ""]);
  });
});

describe("threadTargetStatus", () => {
  const t = (o: Partial<ThreadView>) => ({ state: "connected", status: "idle", statusReason: "at prompt", statusChangedAtMs: null, busyTool: "", flags: [], ...o }) as unknown as ThreadView;
  it.each([
    ["working, with its tool", t({ status: "busy", statusReason: "working", busyTool: "Bash make check" }), "Working · Bash make check"],
    ["working", t({ status: "busy", statusReason: "working" }), "Working"],
    ["waiting", t({ statusReason: "waiting on 1 subagent" }), "Waiting on 1 subagent"],
    ["waiting on a wake", t({ statusReason: "waiting" }), "Waiting on a wake"],
    ["finished", t({ status: "attention", statusReason: "finished", statusChangedAtMs: 1 }), "Finished"],
    ["idle", t({}), "Idle"],
    ["a thread the list does not have", undefined, undefined],
  ])("%s", (_name, thread, want) => {
    expect(threadTargetStatus(thread, 1000)).toBe(want);
  });
});

describe("shellName", () => {
  it.each([
    ["its command", { command: "npm run dev", description: "Dev server" }, "npm run dev"],
    ["the first line, marked", { command: "make\nmake check", description: "" }, "make …"],
    ["else its description", { command: "", description: "Dev server" }, "Dev server"],
  ])("%s", (_name, sh, want) => {
    expect(shellName(sh)).toBe(want);
  });
});

describe("shareWakes", () => {
  it("keeps the old list while the new one says the same", () => {
    const prev = [wake("a", "thread")];
    expect(shareWakes(prev, [wake("a", "thread")])).toBe(prev);
    const next = [wake("a", "thread", { targetStatus: "x" })];
    expect(shareWakes(prev, next)).toBe(next);
  });
});
