import { describe, expect, it } from "vitest";
import type { UsageBucketView } from "@/api/session";
import { OTHER, dayLabel, labelledDays, niceStep, seriesOf, usagePageData, utcDays } from "./usageData";

function bucket(over: Partial<UsageBucketView>): UsageBucketView {
  return { model: "claude-opus-5-5", tier: "", speed: "", day: "2026-10-10", requests: 1, input: 0, output: 0, cacheRead: 100, cacheWrite5m: 0, cacheWrite1h: 0, costUsd: 1, unpriced: false, ...over };
}

// 2026-10-10T23:30Z: still the 10th in UTC.
const NOW = Date.UTC(2026, 9, 10, 23, 30);

describe("utcDays", () => {
  it.each([
    [1, ["2026-10-10"]],
    [3, ["2026-10-08", "2026-10-09", "2026-10-10"]],
  ])("%d days end today, oldest first", (n, want) => {
    expect(utcDays(NOW, n)).toEqual(want);
  });

  it("crosses month ends", () => {
    expect(utcDays(Date.UTC(2026, 9, 1, 0, 5), 2)).toEqual(["2026-09-30", "2026-10-01"]);
  });

  it("has n days", () => {
    expect(utcDays(NOW, 90)).toHaveLength(90);
    expect(utcDays(NOW, 90)[0]).toBe("2026-07-13");
  });
});

describe("usagePageData", () => {
  const days = utcDays(NOW, 7); // 2026-10-04 … 2026-10-10

  it("keeps buckets on the range's days only (not older ones, not \"unknown\")", () => {
    const d = usagePageData(
      [[bucket({ day: "2026-10-03", costUsd: 100 }), bucket({ day: "2026-10-04", costUsd: 2 }), bucket({ day: "unknown", costUsd: 50 }), bucket({ costUsd: 3 })]],
      [],
      days,
    );
    expect(d.totals.costUsd).toBe(5);
    expect(d.totals.requests).toBe(2);
  });

  it("adds the retired ledger but counts only live threads with usage in the range", () => {
    const d = usagePageData([[bucket({})], [bucket({ day: "2026-09-01" })], []], [bucket({ costUsd: 10 }), bucket({ costUsd: 10 })], days);
    expect(d.threads).toBe(1);
    expect(d.totals.costUsd).toBe(21);
  });

  it("has a slot for every day, empty ones included, summed per series", () => {
    const d = usagePageData(
      [[bucket({ day: "2026-10-05", cacheRead: 10, costUsd: 1 }), bucket({ day: "2026-10-05", tier: "", speed: "fast", cacheRead: 5, costUsd: 2 })]],
      [bucket({ day: "2026-10-05", model: "claude-haiku-5-5", cacheRead: 7, costUsd: 0.5 })],
      days,
    );
    expect(d.daily.map((x) => x.day)).toEqual(days);
    expect(d.daily[1]).toEqual({ day: "2026-10-05", tokens: { "claude-opus-5-5": 15, "claude-haiku-5-5": 7 }, cost: { "claude-opus-5-5": 3, "claude-haiku-5-5": 0.5 } });
    expect(d.daily[0]).toEqual({ day: "2026-10-04", tokens: {}, cost: {} });
  });

  it("folds models without a colour slot into Other on the chart, but lists them by id", () => {
    const d = usagePageData(
      [[bucket({ model: "claude-opus-5", unpriced: true, costUsd: 0, cacheRead: 30 }), bucket({ model: "claude-opus-4-8", cacheRead: 20 }), bucket({ model: "claude-haiku-5-5" })]],
      [bucket({ model: "claude-fable-5-1" })],
      days,
    );
    expect(d.series).toEqual(["claude-fable-5-1", "claude-haiku-5-5", OTHER]);
    expect(d.daily.at(-1)?.tokens[OTHER]).toBe(50);
    expect(d.models.map((m) => m.model).sort()).toEqual(["claude-fable-5-1", "claude-haiku-5-5", "claude-opus-4-8", "claude-opus-5"]);
  });

  it("is empty for a range without usage", () => {
    const d = usagePageData([[bucket({ day: "2026-01-01" })]], [], days);
    expect(d.totals.tokens).toBe(0);
    expect(d.series).toEqual([]);
    expect(d.models).toEqual([]);
    expect(d.threads).toBe(0);
  });
});

describe("seriesOf", () => {
  it.each([
    ["claude-opus-5-5", "claude-opus-5-5"],
    ["claude-opus-5", OTHER],
    ["<synthetic>", OTHER],
  ])("%s → %s", (model, want) => {
    expect(seriesOf(model)).toBe(want);
  });
});

describe("niceStep", () => {
  it.each([
    [281e6, 100e6],
    [88.59, 25],
    [0.006, 0.002],
    [0, 1],
  ])("max %d → step %d", (max, want) => {
    expect(niceStep(max)).toBeCloseTo(want, 10);
  });
});

describe("labelledDays", () => {
  it.each([
    [1, [0]],
    [7, [0, 1, 2, 3, 4, 5, 6]],
    [14, [0, 2, 4, 6, 8, 10, 12, 13]],
    [30, [0, 4, 8, 12, 16, 20, 24, 29]],
  ])("%d days → %j", (n, want) => {
    expect(labelledDays(n)).toEqual(want);
  });

  it("labels 90 days about every 12 and always today", () => {
    const l = labelledDays(90);
    expect(l.at(-1)).toBe(89);
    expect(l.length).toBeLessThanOrEqual(9);
  });
});

describe("dayLabel", () => {
  it("is the UTC month and day", () => {
    expect(dayLabel("2026-10-06")).toBe("Oct 6");
    expect(dayLabel("unknown")).toBe("unknown");
  });
});
