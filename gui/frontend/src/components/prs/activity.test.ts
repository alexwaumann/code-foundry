import { describe, expect, it } from "vitest";
import type { MonthView } from "@/api/gh";
import { axisLabel, chartMonths, countScale, countStep, labelledIndex, monthLabelAt, tickLabel, tooltipSide } from "./activity";

// 2026-10-17 noon, local time (the daemon's months are local too).
const NOW = new Date(2026, 9, 17, 12).getTime();

const SIX: MonthView[] = [
  { month: "2026-10", commits: 16, merged: 2 },
  { month: "2026-09", commits: 463, merged: 38 },
  { month: "2026-08", commits: 210, merged: 17 },
  { month: "2026-07", commits: 96, merged: 9 },
  { month: "2026-06", commits: 0, merged: 0 },
  { month: "2026-05", commits: 41, merged: 3 },
];

describe("monthLabelAt", () => {
  it.each([
    [new Date(2026, 9, 17, 12).getTime(), "2026-10"],
    [new Date(2026, 0, 1, 0, 0, 1).getTime(), "2026-01"],
    [new Date(2025, 11, 31, 23, 59).getTime(), "2025-12"],
  ])("%d is %s", (now, want) => {
    expect(monthLabelAt(now)).toBe(want);
  });
});

describe("chartMonths", () => {
  it("orders oldest to newest and marks the current month partial", () => {
    const got = chartMonths(SIX, NOW);
    expect(got.map((m) => m.month)).toEqual(["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
    expect(got.map((m) => m.partial)).toEqual([false, false, false, false, false, true]);
    expect(got[3]).toEqual({ month: "2026-08", commits: 210, merged: 17, partial: false });
  });

  it.each([0, 1, 2, 3, 4, 5, 6])("keeps the newest %d months in order", (n) => {
    const got = chartMonths(SIX.slice(0, n), NOW);
    expect(got).toHaveLength(n);
    expect(got.map((m) => m.month)).toEqual(SIX.slice(0, n).map((m) => m.month).reverse());
  });

  it("marks nothing partial when the snapshot predates a rollover", () => {
    expect(chartMonths(SIX, new Date(2026, 10, 1, 0, 5).getTime()).some((m) => m.partial)).toBe(false);
  });

  it("drops unlabelled months", () => {
    expect(chartMonths([{ month: "", commits: 0, merged: 0 }], NOW)).toEqual([]);
  });
});

describe("labelledIndex", () => {
  it.each([
    ["six months, current partial", 6, NOW, 4],
    ["only the current month", 1, NOW, -1],
    ["current and one closed", 2, NOW, 0],
    ["no months", 0, NOW, -1],
    ["after a rollover: the newest", 6, new Date(2026, 10, 2).getTime(), 5],
  ])("%s", (_name, n, now, want) => {
    expect(labelledIndex(chartMonths(SIX.slice(0, n), now))).toBe(want);
  });
});

describe("countStep / countScale", () => {
  it.each([
    [0, 1, 1, [0, 1]],
    [1, 1, 1, [0, 1]],
    [3, 1, 3, [0, 1, 2, 3]],
    [9, 2, 10, [0, 2, 4, 6, 8, 10]],
    [38, 10, 40, [0, 10, 20, 30, 40]],
    [40, 10, 40, [0, 10, 20, 30, 40]],
    [463, 200, 600, [0, 200, 400, 600]],
    [1544, 500, 2000, [0, 500, 1000, 1500, 2000]],
  ])("max %d: step %d, top %d", (max, step, top, ticks) => {
    expect(countStep(max)).toBe(step);
    expect(countScale(max)).toEqual({ step, top, ticks });
  });

  it("never gives a fractional step", () => {
    for (let max = 0; max < 5000; max += 7) expect(Number.isInteger(countStep(max))).toBe(true);
  });
});

describe("tooltipSide", () => {
  it.each([
    [0, 6, "right"],
    [2, 6, "right"],
    [3, 6, "left"],
    [5, 6, "left"],
    [0, 1, "right"],
    [0, 2, "right"],
    [1, 2, "left"],
    [1, 3, "right"],
    [2, 3, "left"],
  ] as const)("index %d of %d goes %s", (i, n, want) => {
    expect(tooltipSide(i, n)).toBe(want);
  });
});

describe("axisLabel / tickLabel", () => {
  it.each([
    [{ month: "2026-10", partial: true }, "OCT ·"],
    [{ month: "2026-09", partial: false }, "SEP"],
    [{ month: "2027-01", partial: false }, "JAN"],
    [{ month: "", partial: false }, ""],
  ])("%o is %s", (m, want) => {
    expect(axisLabel(m)).toBe(want);
  });

  it("groups thousands", () => {
    expect([0, 40, 1500].map(tickLabel)).toEqual(["0", "40", "1,500"]);
  });
});
