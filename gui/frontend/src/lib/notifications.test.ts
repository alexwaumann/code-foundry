import { describe, expect, it } from "vitest";
import type { NotificationView } from "@/api/notifications";
import { note, noteEvent } from "@/test/notificationFakes";
import {
  ARRIVAL_BURST_MS,
  arrivalToasts,
  bellCount,
  NO_BURST,
  NO_MARK,
  shownNotifications,
  sourceLabel,
  threadMark,
  threadNotifications,
  timeSensitiveArrivals,
  unseenIds,
  type ArrivalBurst,
  type ThreadMarkTone,
} from "./notifications";

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
    ["none", [], { count: 0, urgent: false, unseen: false, unseenUrgent: false }],
    ["normal ones", [note("a"), note("b")], { count: 2, urgent: false, unseen: false, unseenUrgent: false }],
    ["one time-sensitive", [note("a", { timeSensitive: true }), note("b")], { count: 2, urgent: true, unseen: false, unseenUrgent: false }],
    ["a snoozed time-sensitive one neither counts nor tones", [{ ...snoozed("a"), timeSensitive: true }, note("b")], { count: 1, urgent: false, unseen: false, unseenUrgent: false }],
    ["an unseen one", [note("a", { seen: false }), note("b")], { count: 2, urgent: false, unseen: true, unseenUrgent: false }],
    ["an unseen time-sensitive one", [note("a", { seen: false, timeSensitive: true }), note("b")], { count: 2, urgent: true, unseen: true, unseenUrgent: true }],
    ["a seen time-sensitive one beside an unseen one", [note("a", { timeSensitive: true }), note("b", { seen: false })], { count: 2, urgent: true, unseen: true, unseenUrgent: false }],
    ["an unseen snoozed time-sensitive one", [{ ...snoozed("a"), timeSensitive: true, seen: false }, note("b")], { count: 1, urgent: false, unseen: false, unseenUrgent: false }],
  ])("%s", (_, notes, want) => {
    expect(bellCount(noteEvent(notes).snapshot)).toEqual(want);
  });

  it("a daemon without the unseen count lights nothing, whatever the flags say", () => {
    const s = noteEvent([note("a", { seen: false, timeSensitive: true })]).snapshot;
    expect(bellCount({ ...s, unseen: 0 })).toMatchObject({ unseen: false, unseenUrgent: false });
    expect(unseenIds({ ...s, unseen: 0 })).toEqual([]);
  });
});

describe("unseenIds", () => {
  it("lists the shown unseen ones in the daemon's order", () => {
    const ev = noteEvent([note("n-c", { seen: false }), note("n-a"), note("n-b", { seen: false }), { ...snoozed("n-s"), seen: false }]);
    expect(unseenIds(ev.snapshot)).toEqual(["n-c", "n-b"]);
    expect(unseenIds(null)).toEqual([]);
  });
});

describe("sourceLabel", () => {
  it.each([
    ["command", undefined, "Code Foundry"],
    ["command", "Command", "Code Foundry"],
    ["plugins", undefined, "Plugins"],
    ["plugins", "Plugins!", "Plugins"],
    ["github", undefined, "GitHub"],
    ["github", "Some plugin", "GitHub"],
    ["app", undefined, "Code Foundry"],
    ["app", "Some plugin", "Code Foundry"],
    ["constructor", undefined, "constructor"],
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

// docs/notes/notifications-4-row-mark.md: a thread's row mark and its card's list.
describe("threadNotifications", () => {
  const snap = noteEvent([
    note("n-1", { threadId: "s-1", timeSensitive: true }),
    note("n-2", { threadId: "s-2" }),
    note("n-3", { threadId: "s-1" }),
    note("n-4", { threadId: "s-1", status: "snoozed" }),
    note("n-5", { threadId: "s-1", status: "scheduled" }),
    note("n-6"),
  ]).snapshot;

  it("lists the shown ones naming the thread, in the daemon's order; snoozed and scheduled ones wait", () => {
    expect(threadNotifications(snap, "s-1").map((n) => n.id)).toEqual(["n-1", "n-3"]);
    expect(threadNotifications(snap, "s-2").map((n) => n.id)).toEqual(["n-2"]);
  });

  it("none for a thread nothing names, for no thread id, and before a snapshot", () => {
    expect(threadNotifications(snap, "s-9")).toEqual([]);
    expect(threadNotifications(snap, "")).toEqual([]);
    expect(threadNotifications(null, "s-1")).toEqual([]);
  });
});

describe("threadMark", () => {
  const mark = (...notes: NotificationView[]) => threadMark(noteEvent(notes).snapshot, "s-1");
  const on = (id: string, o: Partial<NotificationView> = {}) => note(id, { threadId: "s-1", ...o });

  it.each<[string, NotificationView[], number, ThreadMarkTone]>([
    ["one info: muted", [on("a")], 1, "muted"],
    ["a warning: the attention tone", [on("a"), on("b", { level: "warning" })], 2, "warning"],
    ["a time-sensitive info: the attention tone", [on("a", { timeSensitive: true })], 1, "warning"],
    ["an error wins over a warning", [on("a", { level: "warning" }), on("b", { level: "error" })], 2, "error"],
    ["an error wins over a time-sensitive one", [on("a", { timeSensitive: true }), on("b", { level: "error" })], 2, "error"],
    ["a snoozed error counts for nothing", [on("a"), on("b", { level: "error", status: "snoozed" })], 1, "muted"],
    ["another thread's error is not this thread's", [on("a"), note("b", { threadId: "s-2", level: "error" })], 1, "muted"],
  ])("%s", (_name, notes, count, tone) => {
    expect(mark(...notes)).toEqual({ count, tone });
  });

  it("is the one shared NO_MARK with none, so a selector over it never changes", () => {
    expect(mark()).toBe(NO_MARK);
    expect(mark(note("b", { threadId: "s-2" }))).toBe(NO_MARK);
    expect(threadMark(null, "s-1")).toBe(NO_MARK);
    expect(NO_MARK).toEqual({ count: 0, tone: "muted" });
  });
});
