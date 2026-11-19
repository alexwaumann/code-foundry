import { describe, expect, it } from "vitest";
import { bulkMenuItems, bulkSpaceChoices, type BulkThreadFacts } from "./bulkMenu";

const live: BulkThreadFacts = { archivedAtMs: null, snoozedUntilMs: null, savedAtMs: null, setup: null };
const archived: BulkThreadFacts = { ...live, archivedAtMs: 1 };
const snoozed: BulkThreadFacts = { ...live, snoozedUntilMs: 5 };
const saved: BulkThreadFacts = { ...live, savedAtMs: 5 };
const settingUp: BulkThreadFacts = { ...live, setup: { phase: "running" } };
const setupDone: BulkThreadFacts = { ...live, setup: { phase: "done" } };

describe("bulkMenuItems", () => {
  it.each([
    { name: "live threads: snooze, archive, move, remove", threads: [live, live], want: { snooze: true, unsnooze: false, archive: "archive", move: true, remove: true } },
    { name: "all archived: unarchive", threads: [archived, archived], want: { snooze: true, unsnooze: false, archive: "unarchive", move: true, remove: true } },
    { name: "archived and not: neither", threads: [archived, live], want: { snooze: true, unsnooze: false, archive: null, move: true, remove: true } },
    { name: "all snoozed or saved: unsnooze too", threads: [snoozed, saved], want: { snooze: true, unsnooze: true, archive: "archive", move: true, remove: true } },
    { name: "one not snoozed: no unsnooze", threads: [snoozed, live], want: { snooze: true, unsnooze: false, archive: "archive", move: true, remove: true } },
    { name: "one being set up: no snooze", threads: [live, settingUp], want: { snooze: false, unsnooze: false, archive: "archive", move: true, remove: true } },
    { name: "a finished setup snoozes", threads: [live, setupDone], want: { snooze: true, unsnooze: false, archive: "archive", move: true, remove: true } },
    { name: "nothing selected: nothing", threads: [], want: { snooze: false, unsnooze: false, archive: null, move: false, remove: false } },
  ])("$name", ({ threads, want }) => {
    expect(bulkMenuItems(threads)).toEqual(want);
  });
});

describe("bulkSpaceChoices", () => {
  const spaces = [
    { id: "sp-1", name: "Main" },
    { id: "sp-2", name: "Review" },
  ];
  it("marks a space here only when every thread lives there", () => {
    expect(bulkSpaceChoices(spaces, ["sp-1", "sp-1"]).map((s) => s.here)).toEqual([true, false]);
    expect(bulkSpaceChoices(spaces, ["sp-1", "sp-2"]).map((s) => s.here)).toEqual([false, false]);
    expect(bulkSpaceChoices(spaces, []).map((s) => s.here)).toEqual([false, false]);
  });
});
