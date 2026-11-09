import { describe, expect, it } from "vitest";
import { addDays, addMonths, clampDate, dateError, daysIn, formatDay, formatDayLong, inMonth, inRange, isIsoDate, monthGrid, monthTitle, parseIso, quickPicks, todayIso, weekStartOf, weekday, weekdayNames } from "./date";

describe("ISO dates", () => {
  it.each<[string, boolean]>([
    ["2026-11-14", true],
    ["2028-02-29", true],
    ["0001-01-01", true],
    ["0099-06-30", true],
    ["2026-02-29", false],
    ["2026-02-30", false],
    ["2026-13-01", false],
    ["2026-00-10", false],
    ["2026-1-4", false],
    ["2026-11-14T00:00:00Z", false],
    ["tomorrow", false],
    ["", false],
  ])("%s → %s", (s, ok) => {
    expect(isIsoDate(s)).toBe(ok);
  });

  it("keeps two-digit years", () => {
    expect(parseIso("0099-06-30")).toEqual({ y: 99, m: 6, d: 30 });
    expect(addDays("0099-12-31", 1)).toBe("0100-01-01");
  });

  it.each<[string, number, string]>([
    ["2026-11-14", 1, "2026-11-15"],
    ["2026-11-30", 1, "2026-12-01"],
    ["2026-12-31", 1, "2027-01-01"],
    ["2026-03-01", -1, "2026-02-28"],
    ["2028-03-01", -1, "2028-02-29"],
    // The day a European clock moves: counted in UTC, nothing shifts.
    ["2026-03-29", 1, "2026-03-30"],
    ["2026-11-01", 7, "2026-11-08"],
  ])("addDays(%s, %d)", (iso, n, want) => {
    expect(addDays(iso, n)).toBe(want);
  });

  it.each<[string, number, string]>([
    ["2026-01-31", 1, "2026-02-28"],
    ["2028-01-31", 1, "2028-02-29"],
    ["2026-12-15", 1, "2027-01-15"],
    ["2026-01-15", -1, "2025-12-15"],
    ["2026-03-31", -1, "2026-02-28"],
  ])("addMonths(%s, %d)", (iso, n, want) => {
    expect(addMonths(iso, n)).toBe(want);
  });

  it("knows month lengths and weekdays", () => {
    expect([daysIn(2026, 2), daysIn(2028, 2), daysIn(2026, 11), daysIn(2026, 12)]).toEqual([28, 29, 30, 31]);
    expect(weekday("2026-11-08")).toBe(0);
    expect(weekday("2026-11-09")).toBe(1);
  });

  it("takes today from the local clock", () => {
    expect(todayIso(new Date(2026, 10, 8, 23, 59))).toBe("2026-11-08");
    expect(todayIso(new Date(2026, 0, 1, 0, 0))).toBe("2026-01-01");
  });
});

describe("quick picks", () => {
  it.each<[string, string, string]>([
    // [today, tomorrow, next Monday]
    ["2026-11-08", "2026-11-09", "2026-11-09"], // a Sunday: Monday is tomorrow
    ["2026-11-09", "2026-11-10", "2026-11-16"], // a Monday: a week on
    ["2026-11-14", "2026-11-15", "2026-11-16"], // a Saturday
    ["2026-12-31", "2027-01-01", "2027-01-04"], // over the year
  ])("from %s", (today, tomorrow, nextMonday) => {
    expect(quickPicks(today)).toEqual({ today, tomorrow, nextMonday });
  });
});

describe("range", () => {
  it.each<[string, string | undefined, string | undefined, boolean, string]>([
    ["2026-11-14", undefined, undefined, true, "2026-11-14"],
    ["2026-11-14", "2026-11-14", "2026-11-14", true, "2026-11-14"],
    ["2026-11-13", "2026-11-14", "", false, "2026-11-14"],
    ["2026-11-15", "", "2026-11-14", false, "2026-11-14"],
    ["2026-11-15", "2026-11-01", "2026-11-30", true, "2026-11-15"],
  ])("%s in %s..%s", (iso, min, max, ok, clamped) => {
    expect(inRange(iso, min, max)).toBe(ok);
    expect(clampDate(iso, min, max)).toBe(clamped);
  });

  it.each<[string, string | undefined, string | undefined, string | null]>([
    ["", undefined, undefined, null],
    ["2026-11-14", undefined, undefined, null],
    ["14/11/2026", undefined, undefined, "Not a date (YYYY-MM-DD)"],
    ["2026-02-30", undefined, undefined, "Not a date (YYYY-MM-DD)"],
    ["2026-10-31", "2026-11-01", undefined, "On or after Sun, Nov 1"],
    ["2026-12-01", undefined, "2026-11-30", "On or before Mon, Nov 30"],
    // A bound that is not a date is ignored (the daemon refuses such a view anyway).
    ["2026-12-01", "soon", "", null],
  ])("dateError(%s, %s, %s)", (v, min, max, want) => {
    expect(dateError(v, min, max, "2026-11-08", "en-US")).toBe(want);
  });
});

describe("the month grid", () => {
  it("starts on the week start, the neighbouring months' days around the month", () => {
    // November 2026 starts on a Sunday.
    const mon = monthGrid(2026, 11, 1);
    expect(mon[0]).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
    expect(mon[1]?.[0]).toBe("2026-11-02");
    expect(mon.at(-1)).toEqual(["2026-11-30", "2026-12-01", "2026-12-02", "2026-12-03", "2026-12-04", "2026-12-05", "2026-12-06"]);
    expect(mon).toHaveLength(6);
    const sun = monthGrid(2026, 11, 0);
    expect(sun[0]?.[0]).toBe("2026-11-01");
    expect(sun).toHaveLength(5);
    expect(sun.flat().filter((d) => inMonth(d, 2026, 11))).toHaveLength(30);
  });

  it("fills a February that fits four weeks", () => {
    // February 2026 starts on a Sunday and has 28 days.
    expect(monthGrid(2026, 2, 0)).toHaveLength(4);
    expect(monthGrid(2026, 2, 1)).toHaveLength(5);
  });

  it("knows a day's month", () => {
    expect(inMonth("2026-11-01", 2026, 11)).toBe(true);
    expect(inMonth("2026-10-31", 2026, 11)).toBe(false);
    expect(inMonth("2026-11-01", 2026, 1)).toBe(false);
  });
});

describe("locale", () => {
  it("names weekdays from the week start", () => {
    expect(weekdayNames(1, "en-US").map((d) => d.narrow)).toEqual(["M", "T", "W", "T", "F", "S", "S"]);
    expect(weekdayNames(0, "en-US")[0]).toEqual({ narrow: "S", long: "Sunday" });
    expect(weekdayNames(1, "de-DE")[0]?.long).toBe("Montag");
  });

  it("titles the month", () => {
    expect(monthTitle(2026, 11, "en-US")).toBe("November 2026");
    expect(monthTitle(2026, 11, "fr-FR")).toBe("novembre 2026");
  });

  it("formats a day short, with the year only when it is another year", () => {
    expect(formatDay("2026-11-14", "2026-11-08", "en-US")).toBe("Sat, Nov 14");
    expect(formatDay("2027-01-04", "2026-11-08", "en-US")).toBe("Mon, Jan 4, 2027");
    expect(formatDayLong("2026-11-14", "en-US")).toBe("Saturday, November 14, 2026");
  });

  it("reads the locale's week start, Monday when it cannot", () => {
    const loc = new Intl.Locale("en-US") as Intl.Locale & { getWeekInfo?: unknown; weekInfo?: unknown };
    if (loc.getWeekInfo !== undefined || loc.weekInfo !== undefined) {
      expect(weekStartOf("en-US")).toBe(0);
      expect(weekStartOf("en-GB")).toBe(1);
    }
    expect(weekStartOf("not a locale!")).toBe(1);
  });
});
