import { describe, expect, it } from "vitest";
import type { UsageBucketView } from "@/api/threads";
import { bucketTokens, compareModels, emptyTotals, fmtShare, fmtTok, fmtUsd, modelBaseId, modelColors, modelFamily, TOKEN_KINDS, tint, totalUsage, usageByModel } from "./usage";

function bucket(model: string, o: Partial<UsageBucketView> = {}): UsageBucketView {
  return {
    model,
    tier: "",
    speed: "",
    day: "2026-10-10",
    requests: 1,
    input: 10,
    output: 20,
    cacheRead: 300,
    cacheWrite5m: 0,
    cacheWrite1h: 40,
    costUsd: 1,
    unpriced: false,
    inputCostUsd: 0.1,
    outputCostUsd: 0.4,
    cacheReadCostUsd: 0.2,
    cacheWrite5mCostUsd: 0,
    cacheWrite1hCostUsd: 0.3,
    cacheSavingsUsd: 0,
    ...o,
  };
}

const unpriced = (model: string, o: Partial<UsageBucketView> = {}) =>
  bucket(model, { costUsd: 0, unpriced: true, inputCostUsd: 0, outputCostUsd: 0, cacheReadCostUsd: 0, cacheWrite5mCostUsd: 0, cacheWrite1hCostUsd: 0, ...o });

describe("folds", () => {
  it("totals nothing as zero, neither unpriced nor all-unpriced", () => {
    expect(totalUsage([])).toEqual(emptyTotals());
  });

  it("sums every counter and per-kind cost over buckets", () => {
    const t = totalUsage([bucket("claude-opus-5-5"), bucket("claude-opus-5-5", { day: "2026-10-11", requests: 2 }), bucket("claude-haiku-5-5")]);
    expect(t).toMatchObject({ requests: 4, input: 30, output: 60, cacheRead: 900, cacheWrite5m: 0, cacheWrite1h: 120, tokens: 1110, unpriced: false, allUnpriced: false });
    expect(t.costUsd).toBeCloseTo(3);
    expect(t.outputCostUsd).toBeCloseTo(1.2);
    expect(t.cacheWrite1hCostUsd).toBeCloseTo(0.9);
    expect(bucketTokens(bucket("x"))).toBe(370);
  });

  it.each<[string, UsageBucketView[], boolean, boolean]>([
    ["all priced", [bucket("a")], false, false],
    ["one unpriced", [bucket("a"), unpriced("b")], true, false],
    ["all unpriced", [unpriced("b"), unpriced("c")], true, true],
  ])("flags unpriced usage: %s", (_name, buckets, some, all) => {
    expect(totalUsage(buckets)).toMatchObject({ unpriced: some, allUnpriced: all });
  });

  it("groups by model across tiers, speeds and days, most expensive first", () => {
    const rows = usageByModel([
      bucket("claude-haiku-5-5", { costUsd: 0.5 }),
      bucket("claude-opus-5-5", { costUsd: 2 }),
      bucket("claude-haiku-5-5", { tier: "long", day: "2026-10-11", costUsd: 0.25, requests: 3 }),
      unpriced("claude-opus-5", { input: 1_000_000 }),
      bucket("claude-opus-5-5", { speed: "fast", costUsd: 4 }),
    ]);
    expect(rows.map((r) => r.model)).toEqual(["claude-opus-5-5", "claude-haiku-5-5", "claude-opus-5"]);
    expect(rows[0]).toMatchObject({ requests: 2, costUsd: 6, unpriced: false });
    expect(rows[1]).toMatchObject({ requests: 4, costUsd: 0.75, tokens: 740 });
    expect(rows[2]).toMatchObject({ costUsd: 0, unpriced: true, allUnpriced: true });
  });

  it("orders equal costs by tokens, then by id", () => {
    const rows = usageByModel([unpriced("b"), unpriced("a"), unpriced("c", { input: 1000 })]);
    expect(rows.map((r) => r.model)).toEqual(["c", "a", "b"]);
  });

  it("lists the token kinds in display order with their labels", () => {
    expect(TOKEN_KINDS.map((k) => k.label)).toEqual(["Input", "Output", "Cache read", "Cache write · 5m", "Cache write · 1h"]);
  });
});

describe("model colours", () => {
  it.each<[string, string | undefined]>([
    ["claude-opus-5-5", "opus"],
    ["claude-opus-4-8[1m]", "opus"],
    ["claude-opus-4-7", "opus"],
    ["claude-fable-5-1", "fable"],
    ["claude-mythos-1", "fable"],
    ["claude-sonnet-5", "sonnet"],
    ["claude-sonnet-4-6[1m]", "sonnet"],
    ["claude-haiku-5-5-20261001", "haiku"],
    ["claude-3-5-sonnet-20241022", "sonnet"],
    ["us.anthropic.claude-opus-4-8-v1:0", "opus"],
    ["claude-opusx-1", undefined],
    ["claude-next-1", undefined],
    ["<synthetic>", undefined],
    ["", undefined],
  ])("%s is in family %s", (model, family) => {
    expect(modelFamily(model)).toBe(family);
  });

  it.each([
    ["claude-haiku-5-5-20261001", "claude-haiku-5-5"],
    ["claude-opus-4-8[1m]", "claude-opus-4-8"],
    ["claude-opus-4-8@20261001", "claude-opus-4-8"],
    ["claude-sonnet-5", "claude-sonnet-5"],
  ])("%s's base id is %s", (model, want) => {
    expect(modelBaseId(model)).toBe(want);
  });

  it("orders by family, newest version first, others last", () => {
    const models = ["claude-next-1", "claude-haiku-5-5", "claude-sonnet-4-6", "claude-opus-4-7", "claude-sonnet-5", "claude-opus-5-5", "claude-fable-5-1", "claude-opus-4-8", "claude-opus-5"];
    expect(models.sort(compareModels)).toEqual(["claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-fable-5-1", "claude-sonnet-5", "claude-sonnet-4-6", "claude-haiku-5-5", "claude-next-1"]);
  });

  it.each([
    ["#2a78d6", 0, "#2a78d6"],
    ["#000000", 0.5, "#808080"],
    ["#2a78d6", 1, "#ffffff"],
  ])("tints %s by %d to %s", (hex, t, want) => {
    expect(tint(hex, t)).toBe(want);
  });

  it("gives a family's newest model its hue and each older one a lighter shade; others are grey", () => {
    const c = modelColors(["claude-opus-4-7", "claude-sonnet-5", "claude-opus-4-8", "claude-next-1", "claude-opus-5-5"]);
    expect(c.get("claude-opus-5-5")).toEqual({ "--sw-l": "#2a78d6", "--sw-d": "#3987e5" });
    expect(c.get("claude-opus-4-8")).toEqual({ "--sw-l": tint("#2a78d6", 0.38), "--sw-d": tint("#3987e5", 0.38) });
    expect(c.get("claude-sonnet-5")).toEqual({ "--sw-l": "#1baf7a", "--sw-d": "#199e70" });
    expect(c.get("claude-next-1")).toEqual({ "--sw-l": "oklch(0.65 0 0)", "--sw-d": "oklch(0.6 0 0)" });
    const opus = ["claude-opus-5-5", "claude-opus-4-8", "claude-opus-4-7"].map((m) => c.get(m)?.["--sw-l"]);
    expect(new Set(opus).size).toBe(3);
  });

  it("a lone model of a family takes the family's hue whatever its version", () => {
    expect(modelColors(["claude-sonnet-4-6"]).get("claude-sonnet-4-6")).toEqual({ "--sw-l": "#1baf7a", "--sw-d": "#199e70" });
  });
});

describe("formats", () => {
  it.each<[number, string]>([
    [0, "0"],
    [999, "999"],
    [1000, "1K"],
    [1234, "1.2K"],
    [12_900, "12.9K"],
    [38_900, "38.9K"],
    [99_960, "100K"],
    [980_400, "980K"],
    [999_600, "1M"],
    [3_400_000, "3.4M"],
    [1_500_000, "1.5M"],
    [10_700_000, "10.7M"],
    [261_229_800, "261M"],
    [349_000_000, "349M"],
    [999_600_000, "1B"],
    [1_500_000_000, "1.5B"],
    [1_440_000_000, "1.44B"],
    [120_000_000_000, "120B"],
  ])("fmtTok(%d) = %s", (n, want) => {
    expect(fmtTok(n)).toBe(want);
  });

  it.each<[number, string]>([
    [0, "$0.00"],
    [0.0000002, "<$0.0001"],
    [0.00005, "$0.0001"],
    [0.00287, "$0.0029"],
    [0.01, "$0.01"],
    [20.07, "$20.07"],
    [141.2, "$141.20"],
    [1234.5, "$1,234.50"],
  ])("fmtUsd(%d) = %s", (v, want) => {
    expect(fmtUsd(v)).toBe(want);
  });

  it.each<[number, number, string]>([
    [101.6, 141.2, "72.0%"],
    [39.6, 141.2, "28.0%"],
    [1, 1, "100.0%"],
    [0.0001, 1, "<0.1%"],
    [0, 1, "0.0%"],
    [0, 0, "—"],
  ])("fmtShare(%d, %d) = %s", (part, total, want) => {
    expect(fmtShare(part, total)).toBe(want);
  });
});
