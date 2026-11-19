import { describe, expect, it } from "vitest";
import { pillSegments, pillStep, pillWidth, segmentForm, snoozeFull, snoozeShort, waitTotal, waitWords, type PillState, type PillStep, type PillWidths } from "./composerPill";

const none: PillState = { working: false, snooze: false, waiting: false, canStopWaiting: false, away: false };

describe("pillSegments", () => {
  it.each<[string, Partial<PillState>, string[]]>([
    ["nothing", {}, []],
    ["working", { working: true }, ["working"]],
    ["snoozed", { snooze: true }, ["snooze"]],
    ["idle and waiting: Stop waiting beside it", { waiting: true, canStopWaiting: true }, ["waiting", "stop"]],
    ["waiting on subagents only: nothing to stop", { waiting: true }, ["waiting"]],
    ["working and waiting: Stop waiting only in the panel", { working: true, waiting: true, canStopWaiting: true }, ["working", "waiting"]],
    ["working and snoozed", { working: true, snooze: true }, ["working", "snooze"]],
    ["scrolled up", { away: true }, ["jump"]],
    ["all four", { working: true, snooze: true, waiting: true, canStopWaiting: true, away: true }, ["working", "snooze", "waiting", "jump"]],
    ["idle, all else", { snooze: true, waiting: true, canStopWaiting: true, away: true }, ["snooze", "waiting", "stop", "jump"]],
  ])("%s", (_name, s, want) => {
    expect(pillSegments({ ...none, ...s })).toEqual(want);
  });
});

describe("segmentForm", () => {
  it.each<[PillStep, number, number, number]>([
    // step, working, snooze, waiting
    [0, 0, 0, 0],
    [1, 0, 0, 1],
    [2, 0, 1, 1],
    [3, 1, 1, 1],
    [4, 1, 1, 2],
  ])("step %i", (step, working, snooze, waiting) => {
    expect([segmentForm("working", step), segmentForm("snooze", step), segmentForm("waiting", step), segmentForm("jump", step), segmentForm("stop", step)]).toEqual([working, snooze, waiting, 0, 0]);
  });
});

// Widths as measured in the app at 12px (padding, icons, chevrons in): a long waiting list, a snooze to a weekday.
const working = [124, 74];
const snooze = [196, 100];
const waiting = [262, 112, 62];
const jump = [124];
const stop = [96];
const w = (segments: PillWidths["segments"]): PillWidths => ({ segments, chrome: 2 + Math.max(0, Object.keys(segments).length - 1) });

describe("pillStep", () => {
  it.each<[string, PillWidths, number, PillStep]>([
    ["no segments: nothing to shorten", w({}), 10, 0],
    ["one segment with room", w({ jump }), 400, 0],
    ["all four, wide", w({ working, snooze, waiting, jump }), 760, 0],
    ["all four, the full width exactly", w({ working, snooze, waiting, jump }), 124 + 196 + 262 + 124 + 5, 0],
    ["all four, a pixel short: the waiting list becomes a count", w({ working, snooze, waiting, jump }), 124 + 196 + 262 + 124 + 4, 1],
    ["all four at a 640px pane (548 for the pill)", w({ working, snooze, waiting, jump }), 548, 2],
    ["all four, a little narrower: Working drops its word", w({ working, snooze, waiting, jump }), 420, 3],
    ["all four at a 480px pane (388 for the pill): steps 1 to 3 are not enough", w({ working, snooze, waiting, jump }), 388, 4],
    ["all four, nothing fits: the last step", w({ working, snooze, waiting, jump }), 100, 4],
    ["no waiting segment: step 1 changes nothing, so snooze goes first", w({ working, snooze, jump }), 400, 2],
    ["working and jump only: working drops its word", w({ working, jump }), 220, 3],
    ["idle with Stop waiting: it never shrinks", w({ snooze, waiting, stop, jump }), 388, 4],
  ])("%s", (_name, widths, available, want) => {
    expect(pillStep(widths, available)).toBe(want);
  });

  it("each step is no wider than the one before", () => {
    const all = w({ working, snooze, waiting, jump });
    const widths = ([0, 1, 2, 3, 4] as const).map((s) => pillWidth(all, s));
    expect(widths).toEqual([...widths].sort((a, b) => b - a));
    expect(widths[4]).toBe(74 + 100 + 62 + 124 + 5);
  });
});

describe("the segments' words", () => {
  const now = new Date(2026, 10, 19, 14, 0).getTime();
  it.each([
    [{ kind: "snoozed" as const, until: new Date(2026, 10, 19, 17, 30).getTime() }, "Snoozed until 5:30 PM", "Snoozed"],
    [{ kind: "snoozed" as const, until: new Date(2026, 10, 23, 9, 0).getTime() }, "Snoozed until Mon 9:00 AM", "Snoozed"],
    [{ kind: "saved" as const }, "Saved for later", "Snoozed"],
    [{ kind: "woken" as const, at: now - 5 * 60_000 }, "Snooze ended 5m ago", "Snooze ended"],
    [{ kind: "woken" as const, at: null }, "Snooze ended", "Snooze ended"],
  ])("%o", (s, full, short) => {
    expect(snoozeFull(s, now)).toBe(full);
    expect(snoozeShort(s)).toBe(short);
  });

  it("names what it waits on as the waiting bar did, and counts it", () => {
    const c = { threads: 2, pullRequests: 1, actionRuns: 0, sources: 0, timers: 1, shells: 0, subagents: 0 };
    expect(waitWords(c)).toBe("2 threads, 1 PR and 1 timer");
    expect(waitTotal(c)).toBe(4);
  });
});
