import { afterAll, describe, expect, it, vi } from "vitest";
import {
  addDays,
  formatClock,
  formatDay,
  monthGrid,
  monthTitle,
  parseTimeValue,
  shiftMonth,
  shortRemaining,
  snoozePresets,
  snoozeTimeFull,
  snoozeTimeShort,
  wallTime,
} from "./snooze";

// Local wall times in a zone with DST (2026: spring forward Sun Mar 8, fall back Sun Nov 1),
// whatever the machine's zone. Node re-reads TZ when it changes. Set at load: the tables
// below build their times when the module is evaluated.
vi.stubEnv("TZ", "America/Chicago");
afterAll(() => {
  vi.unstubAllEnvs();
});

/** A local time (month 1-based) as epoch ms. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const H = 3_600_000;

describe("snoozePresets", () => {
  const presets = (now: number) => Object.fromEntries(snoozePresets(now).map((p) => [p.id, p]));

  it("has the four presets in menu order with their labels", () => {
    expect(snoozePresets(at(2026, 10, 14, 13, 12)).map((p) => [p.id, p.label])).toEqual([
      ["1h", "1 hour"],
      ["3h", "3 hours"],
      ["tomorrow", "Tomorrow"],
      ["next-week", "Next week"],
    ]);
  });

  it.each<[string, number, Record<string, [number, string]>]>([
    [
      "Wednesday afternoon",
      at(2026, 10, 14, 13, 12),
      {
        "1h": [at(2026, 10, 14, 14, 12), "2:12 PM"],
        "3h": [at(2026, 10, 14, 16, 12), "4:12 PM"],
        tomorrow: [at(2026, 10, 15, 9), "Thu 9:00 AM"],
        "next-week": [at(2026, 10, 19, 9), "Mon 9:00 AM"],
      },
    ],
    [
      "Monday morning: next week is the following Monday",
      at(2026, 10, 19, 8, 30),
      {
        "1h": [at(2026, 10, 19, 9, 30), "9:30 AM"],
        "3h": [at(2026, 10, 19, 11, 30), "11:30 AM"],
        tomorrow: [at(2026, 10, 20, 9), "Tue 9:00 AM"],
        "next-week": [at(2026, 10, 26, 9), "Oct 26, 9:00 AM"],
      },
    ],
    [
      "Sunday: next week is tomorrow",
      at(2026, 10, 18, 20),
      {
        "1h": [at(2026, 10, 18, 21), "9:00 PM"],
        "3h": [at(2026, 10, 18, 23), "11:00 PM"],
        tomorrow: [at(2026, 10, 19, 9), "Mon 9:00 AM"],
        "next-week": [at(2026, 10, 19, 9), "Mon 9:00 AM"],
      },
    ],
    [
      "late evening: the hours run past midnight and say the day",
      at(2026, 10, 14, 23, 30),
      {
        "1h": [at(2026, 10, 15, 0, 30), "Thu 12:30 AM"],
        "3h": [at(2026, 10, 15, 2, 30), "Thu 2:30 AM"],
        tomorrow: [at(2026, 10, 15, 9), "Thu 9:00 AM"],
        "next-week": [at(2026, 10, 19, 9), "Mon 9:00 AM"],
      },
    ],
    [
      "after midnight: tomorrow is the next calendar day",
      at(2026, 10, 15, 0, 20),
      {
        "1h": [at(2026, 10, 15, 1, 20), "1:20 AM"],
        "3h": [at(2026, 10, 15, 3, 20), "3:20 AM"],
        tomorrow: [at(2026, 10, 16, 9), "Fri 9:00 AM"],
        "next-week": [at(2026, 10, 19, 9), "Mon 9:00 AM"],
      },
    ],
    [
      "year end",
      at(2026, 12, 31, 18),
      {
        "1h": [at(2026, 12, 31, 19), "7:00 PM"],
        "3h": [at(2026, 12, 31, 21), "9:00 PM"],
        tomorrow: [at(2027, 1, 1, 9), "Fri 9:00 AM"],
        "next-week": [at(2027, 1, 4, 9), "Mon 9:00 AM"],
      },
    ],
    [
      // Spring forward (Sun Mar 8, 2:00 → 3:00): the hours are absolute, the days wall times.
      "Saturday before spring forward",
      at(2026, 3, 7, 23, 30),
      {
        "1h": [at(2026, 3, 8, 0, 30), "Sun 12:30 AM"],
        "3h": [at(2026, 3, 7, 23, 30) + 3 * H, "Sun 3:30 AM"],
        tomorrow: [at(2026, 3, 8, 9), "Sun 9:00 AM"],
        "next-week": [at(2026, 3, 9, 9), "Mon 9:00 AM"],
      },
    ],
    [
      // Fall back (Sun Nov 1, 2:00 → 1:00): 1:30 AM happens twice; 3 hours later is 3:30 AM.
      "Saturday before fall back",
      at(2026, 10, 31, 23, 30),
      {
        "1h": [at(2026, 11, 1, 0, 30), "Sun 12:30 AM"],
        "3h": [at(2026, 10, 31, 23, 30) + 3 * H, "Sun 1:30 AM"],
        tomorrow: [at(2026, 11, 1, 9), "Sun 9:00 AM"],
        "next-week": [at(2026, 11, 2, 9), "Mon 9:00 AM"],
      },
    ],
  ])("%s", (_name, now, want) => {
    const got = presets(now);
    for (const [id, [untilMs, hint]] of Object.entries(want)) {
      expect(got[id]?.untilMs, id).toBe(untilMs);
      expect(got[id]?.hint, id).toBe(hint);
    }
  });

  it("keeps 9:00 AM a wall time across DST: the day after spring forward is 23 hours after 9 AM", () => {
    const sat = snoozePresets(at(2026, 3, 7, 9)).find((p) => p.id === "tomorrow");
    expect(sat?.untilMs).toBe(at(2026, 3, 7, 9) + 23 * H);
    expect(new Date(sat?.untilMs ?? 0).getHours()).toBe(9);
    const fall = snoozePresets(at(2026, 10, 31, 9)).find((p) => p.id === "tomorrow");
    expect(fall?.untilMs).toBe(at(2026, 10, 31, 9) + 25 * H);
  });

  it("every preset is in the future", () => {
    for (const now of [at(2026, 10, 19, 0, 0), at(2026, 10, 19, 8, 59), at(2026, 10, 19, 9, 0), at(2026, 10, 19, 23, 59)])
      for (const p of snoozePresets(now)) expect(p.untilMs, p.id).toBeGreaterThan(now);
  });
});

describe("formatting", () => {
  const now = at(2026, 10, 14, 13, 12);

  it.each([
    [at(2026, 10, 14, 0, 5), "12:05 AM"],
    [at(2026, 10, 14, 9), "9:00 AM"],
    [at(2026, 10, 14, 12), "12:00 PM"],
    [at(2026, 10, 14, 14, 12), "2:12 PM"],
  ])("formatClock %#", (ms, want) => {
    expect(formatClock(ms)).toBe(want);
  });

  it.each([
    ["today", at(2026, 10, 14, 16, 12), "4:12 PM"],
    ["tomorrow", at(2026, 10, 15, 9), "Thu 9:00 AM"],
    ["six days ahead", at(2026, 10, 20, 9), "Tue 9:00 AM"],
    ["a week ahead (today's weekday)", at(2026, 10, 21, 9), "Oct 21, 9:00 AM"],
    ["next year", at(2027, 1, 7, 9), "Jan 7, 2027, 9:00 AM"],
    ["yesterday (already due)", at(2026, 10, 13, 9), "Oct 13, 9:00 AM"],
  ])("snoozeTimeShort %s", (_name, ms, want) => {
    expect(snoozeTimeShort(ms, now)).toBe(want);
  });

  it("snoozeTimeFull: weekday, date and time; the year only when it is not this year", () => {
    expect(snoozeTimeFull(at(2026, 10, 15, 9), now)).toBe("Thu, Oct 15, 9:00 AM");
    expect(snoozeTimeFull(at(2027, 1, 7, 9), now)).toBe("Thu, Jan 7, 2027, 9:00 AM");
  });

  it("formatDay and monthTitle", () => {
    expect(formatDay({ year: 2026, month: 9, day: 16 }, now)).toBe("Fri, Oct 16");
    expect(formatDay({ year: 2027, month: 0, day: 1 }, now)).toBe("Fri, Jan 1, 2027");
    expect(monthTitle(2026, 9)).toBe("October 2026");
  });

  it.each([
    [30_000, "<1m"],
    [0, "<1m"],
    [-120_000, "<1m"],
    [60_000, "1m"],
    [45 * 60_000 + 59_000, "45m"],
    [59 * 60_000 + 59_000, "59m"],
    [60 * 60_000, "1h"],
    [2 * H + 59 * 60_000, "2h"],
    [18 * H, "18h"],
    [23 * H + 59 * 60_000, "23h"],
    [24 * H, "1d"],
    [4 * 24 * H + 23 * H, "4d"],
  ])("shortRemaining %i ms → %s", (left, want) => {
    expect(shortRemaining(now + left, now)).toBe(want);
  });
});

describe("calendar", () => {
  const key = (d: { year: number; month: number; day: number }) => `${String(d.month + 1)}/${String(d.day)}`;

  it("October 2026: five weeks from Sun Sep 27 to Sat Oct 31", () => {
    const grid = monthGrid(2026, 9);
    expect(grid).toHaveLength(5);
    expect(grid[0]?.map(key)).toEqual(["9/27", "9/28", "9/29", "9/30", "10/1", "10/2", "10/3"]);
    expect(grid[4]?.map(key)).toEqual(["10/25", "10/26", "10/27", "10/28", "10/29", "10/30", "10/31"]);
  });

  it("whole weeks: trailing days of the next month; six weeks when needed; four for Feb 2026", () => {
    expect(monthGrid(2026, 10).at(-1)?.map(key)).toEqual(["11/29", "11/30", "12/1", "12/2", "12/3", "12/4", "12/5"]);
    expect(monthGrid(2026, 7)).toHaveLength(6); // Aug 2026 starts on a Saturday
    expect(monthGrid(2026, 1)).toHaveLength(4); // Feb 2026 starts on a Sunday, 28 days
  });

  it("days and months step on the calendar across DST and years", () => {
    expect(addDays({ year: 2026, month: 2, day: 7 }, 1)).toEqual({ year: 2026, month: 2, day: 8 });
    expect(addDays({ year: 2026, month: 10, day: 1 }, -1)).toEqual({ year: 2026, month: 9, day: 31 });
    expect(addDays({ year: 2026, month: 11, day: 31 }, 1)).toEqual({ year: 2027, month: 0, day: 1 });
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, month: 0 });
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, month: 11 });
    expect(shiftMonth(2026, 9, 1)).toEqual({ year: 2026, month: 10 });
  });

  it("wallTime: a local time; inside the spring-forward gap it moves forward", () => {
    expect(new Date(wallTime({ year: 2026, month: 9, day: 16 }, 9)).getHours()).toBe(9);
    expect(formatClock(wallTime({ year: 2026, month: 2, day: 8 }, 2, 30))).toBe("3:30 AM");
  });

  it.each<[string, { hour: number; minute: number } | null]>([
    ["09:00", { hour: 9, minute: 0 }],
    ["14:30", { hour: 14, minute: 30 }],
    ["23:59:00", { hour: 23, minute: 59 }],
    ["", null],
    ["24:00", null],
    ["9am", null],
  ])("parseTimeValue %j", (v, want) => {
    expect(parseTimeValue(v)).toEqual(want);
  });
});
