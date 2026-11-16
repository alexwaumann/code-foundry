import { describe, expect, it } from "vitest";
import { note, noteEvent } from "@/test/notificationFakes";
import { ARRIVAL_BURST_MS, arrivalToasts, bellCount, NO_BURST, shownNotifications, sourceLabel, timeSensitiveArrivals, type ArrivalBurst } from "./notifications";

const snoozed = (id: string) => note(id, { status: "snoozed", snoozedUntilMs: 5 });

describe("shownNotifications", () => {
  it("keeps the daemon's order and leaves out snoozed and scheduled ones", () => {
    const ev = noteEvent([note("n-c", { timeSensitive: true }), note("n-a"), note("n-b"), snoozed("n-s"), note("n-w", { status: "scheduled" })]);
    expect(shownNotifications(ev.snapshot).map((n) => n.id)).toEqual(["n-c", "n-a", "n-b"]);
  });

  it("is empty before a snapshot", () => {
    expect(shownNotifications(null)).toEqual([]);
  });
});

describe("bellCount", () => {
  it.each([
    ["none", [], { count: 0, urgent: false }],
    ["normal ones", [note("a"), note("b")], { count: 2, urgent: false }],
    ["one time-sensitive", [note("a", { timeSensitive: true }), note("b")], { count: 2, urgent: true }],
    ["a snoozed time-sensitive one neither counts nor tones", [{ ...snoozed("a"), timeSensitive: true }, note("b")], { count: 1, urgent: false }],
  ])("%s", (_, notes, want) => {
    expect(bellCount(noteEvent(notes).snapshot)).toEqual(want);
  });
});

describe("sourceLabel", () => {
  it.each([
    ["command", undefined, "Code Foundry"],
    ["command", "Command", "Code Foundry"],
    ["jenkins", "Jenkins", "Jenkins"],
    ["jenkins", undefined, "jenkins"],
    ["jenkins", "", "jenkins"],
  ])("%s with display name %s is %s", (source, display, want) => {
    expect(sourceLabel(source, display)).toBe(want);
  });
});

/** Runs events through arrivalToasts in order; returns what each toasted. */
function run(steps: { ev: ReturnType<typeof noteEvent>; at: number; open?: boolean }[]): { each: string[]; more: number }[] {
  let burst: ArrivalBurst = NO_BURST;
  return steps.map((s) => {
    const r = arrivalToasts(burst, s.ev, s.open ?? false, s.at);
    burst = r.burst;
    return { each: r.each.map((n) => n.id), more: r.more };
  });
}

describe("arrivalToasts", () => {
  it("a connect's snapshot (no arrivals) is the baseline: nothing toasts", () => {
    expect(run([{ ev: noteEvent([note("a"), note("b")]), at: 0 }])).toEqual([{ each: [], more: 0 }]);
  });

  it("an arrival toasts; an update of another never does", () => {
    expect(run([{ ev: noteEvent([note("a"), note("b")], ["a"], ["b"]), at: 0 }])).toEqual([{ each: ["a"], more: 0 }]);
    expect(run([{ ev: noteEvent([note("a"), note("b")], [], ["b"]), at: 0 }])).toEqual([{ each: [], more: 0 }]);
  });

  it("nothing while the bell is open", () => {
    expect(run([{ ev: noteEvent([note("a")], ["a"]), at: 0, open: true }])).toEqual([{ each: [], more: 0 }]);
  });

  it("an arrival no longer shown in the snapshot (snoozed at once) does not toast", () => {
    expect(run([{ ev: noteEvent([snoozed("a")], ["a"]), at: 0 }])).toEqual([{ each: [], more: 0 }]);
  });

  it("several in one event: the first two in the snapshot's order, then one count", () => {
    const ev = noteEvent([note("a"), note("b"), note("c"), note("d")], ["d", "c", "b", "a"]);
    expect(run([{ ev, at: 0 }])).toEqual([{ each: ["a", "b"], more: 2 }]);
  });

  it("a burst of events (less than the burst apart) shares the cap; the count grows in place", () => {
    const one = (id: string) => noteEvent([note(id)], [id]);
    const gap = ARRIVAL_BURST_MS - 1;
    expect(run([{ ev: one("a"), at: 0 }, { ev: one("b"), at: gap }, { ev: one("c"), at: 2 * gap }, { ev: one("d"), at: 3 * gap }])).toEqual([
      { each: ["a"], more: 0 },
      { each: ["b"], more: 0 },
      { each: [], more: 1 },
      { each: [], more: 2 },
    ]);
  });

  it("a quiet gap of the burst's length starts a new burst", () => {
    const one = (id: string) => noteEvent([note(id)], [id]);
    expect(run([{ ev: one("a"), at: 0 }, { ev: one("b"), at: 1 }, { ev: one("c"), at: 2 }, { ev: one("d"), at: 2 + ARRIVAL_BURST_MS }])).toEqual([
      { each: ["a"], more: 0 },
      { each: ["b"], more: 0 },
      { each: [], more: 1 },
      { each: ["d"], more: 0 },
    ]);
  });

  it("a time-sensitive arrival always toasts on its own, past the cap too", () => {
    const ev = noteEvent([note("u", { timeSensitive: true }), note("a"), note("b"), note("c")], ["a", "b", "c", "u"]);
    expect(run([{ ev, at: 0 }])).toEqual([{ each: ["u", "a"], more: 2 }]);
    const later = noteEvent([note("v", { timeSensitive: true })], ["v"]);
    expect(run([{ ev, at: 0 }, { ev: later, at: 1 }])).toEqual([
      { each: ["u", "a"], more: 2 },
      { each: ["v"], more: 0 },
    ]);
  });
});

describe("timeSensitiveArrivals", () => {
  it("the arrivals that are shown and time-sensitive; normal, updated and snoozed ones are not", () => {
    const ev = noteEvent([note("u", { timeSensitive: true }), note("w", { timeSensitive: true }), note("n"), { ...snoozed("s"), timeSensitive: true }], ["u", "n", "s"], ["w"]);
    expect(timeSensitiveArrivals(ev)).toEqual(["u"]);
  });

  it("none on a connect's snapshot", () => {
    expect(timeSensitiveArrivals(noteEvent([note("u", { timeSensitive: true })]))).toEqual([]);
  });
});
