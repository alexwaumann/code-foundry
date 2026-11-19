import { describe, expect, it } from "vitest";
import type { ThreadView } from "@/api/threads";
import { note, noteEvent } from "@/test/notificationFakes";
import { thread } from "@/test/projectsWorld";
import { bellArrived, callingIds, initialArrivals, stepArrivals, tiltClass, tilting, TILT_MS, type ArrivalState } from "./arrivals";
import { statusRegistry } from "./statusRegistry";

/**
 * The arrival tilt's rules (docs/notes/arrival-tilt.md): which threads call on the user, when one
 * has just arrived over consecutive snapshots, when a notification event tilts the bell, and how
 * an icon pivots. Which element tilts in each place is the components' tests'.
 */

const data = (...ts: ThreadView[]) => ({ byId: Object.fromEntries(ts.map((t) => [t.id, t])), order: ts.map((t) => t.id) });
const ask = (id: string, reason: string, o: Partial<ThreadView> = {}) => thread(id, { status: "attention", statusReason: reason, ...o });

describe("callingIds", () => {
  it("counts a permission, a question, a plan and a woken snooze; never a finished turn, an error, a working or an idle thread", () => {
    const d = data(
      ask("perm", "permission: Bash"),
      ask("q", "question: Which?"),
      ask("plan", "plan: Ship it"),
      ask("woke", "snooze ended"),
      ask("done", "finished"),
      thread("err", { status: "error", statusReason: "error: boom" }),
      thread("busy", { status: "busy" }),
      thread("idle"),
    );
    expect(callingIds(d)).toEqual(["perm", "q", "plan", "woke"]);
  });

  it("leaves out an archived thread and one another thread created (its creator answers it)", () => {
    const d = data(thread("parent"), ask("child", "permission: Bash", { createdBy: "parent" }), ask("old", "question: Which?", { archivedAtMs: 5 }));
    expect(callingIds(d)).toEqual([]);
  });
});

/** Runs steps from the initial state; returns each step's arrivals. */
function run(steps: { epoch?: number; calling: string[] }[]): string[][] {
  let state: ArrivalState = initialArrivals;
  return steps.map((s) => {
    const r = stepArrivals(state, { epoch: s.epoch ?? 1, calling: s.calling });
    state = r.state;
    return r.arrived;
  });
}

describe("stepArrivals", () => {
  it("the first snapshot after the app loads is the baseline: nothing already calling arrives", () => {
    expect(run([{ calling: ["a", "b"] }])).toEqual([[]]);
  });

  it("a thread that starts calling arrives once; the steps after (re-renders, other threads' changes) do not repeat it", () => {
    expect(run([{ calling: [] }, { calling: ["a"] }, { calling: ["a"] }, { calling: ["a", "b"] }])).toEqual([[], ["a"], [], ["b"]]);
  });

  it("a thread that leaves and calls again later is a new arrival", () => {
    expect(run([{ calling: [] }, { calling: ["a"] }, { calling: [] }, { calling: ["a"] }])).toEqual([[], ["a"], [], ["a"]]);
  });

  it("a reconnect (a new epoch) is a baseline: what started calling while away does not arrive", () => {
    expect(run([{ calling: [] }, { epoch: 2, calling: ["a"] }, { epoch: 2, calling: ["a", "b"] }])).toEqual([[], [], ["b"]]);
  });

  it("a thread that changes its ask while still calling (a permission, then a question, then woken) is the same arrival", () => {
    const steps = [data(thread("a")), data(ask("a", "permission: Bash")), data(ask("a", "question: Which?")), data(ask("a", "snooze ended"))];
    expect(run(steps.map((d) => ({ calling: callingIds(d) })))).toEqual([[], ["a"], [], []]);
  });
});

describe("bellArrived", () => {
  it("tilts for an arrival that is shown", () => {
    expect(bellArrived(noteEvent([note("n-1"), note("n-2")], ["n-2"]))).toBe(true);
  });

  it.each([
    ["a connect's snapshot (no arrivals)", noteEvent([note("n-1")])],
    ["an update only", noteEvent([note("n-1")], [], ["n-1"])],
    ["an arrival snoozed as it came", noteEvent([note("n-1", { status: "snoozed" })], ["n-1"])],
    ["an arrival already gone", noteEvent([], ["n-1"])],
  ])("does not tilt for %s", (_, ev) => {
    expect(bellArrived(ev)).toBe(false);
  });
});

describe("tilting", () => {
  it("lasts TILT_MS from the arrival", () => {
    expect(tilting(1000, 1000)).toBe(true);
    expect(tilting(1000, 1000 + TILT_MS - 1)).toBe(true);
    expect(tilting(1000, 1000 + TILT_MS)).toBe(false);
    expect(tilting(undefined, 0)).toBe(false);
    expect(tilting(null, 0)).toBe(false);
  });
});

describe("tiltClass", () => {
  it("a bell swings from its top; every other icon rocks about its centre", () => {
    expect(tiltClass(statusRegistry.snoozeEnded.icon)).toBe("animate-arrival-tilt origin-[50%_12%]");
    expect(tiltClass(statusRegistry.input.icon)).toBe("animate-arrival-tilt");
    expect(tiltClass(statusRegistry.question.icon)).toBe("animate-arrival-tilt");
    expect(tiltClass(statusRegistry.plan.icon)).toBe("animate-arrival-tilt");
  });
});
