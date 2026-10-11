import { describe, expect, it } from "vitest";
import type { UsageBucketView } from "@/api/session";
import { byModel, formatShare, formatTokens, formatUsd, modelColor, sumBuckets } from "./usage";

function bucket(over: Partial<UsageBucketView>): UsageBucketView {
  return { model: "claude-opus-5-5", tier: "", speed: "", day: "2026-10-10", requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, costUsd: 0, unpriced: false, ...over };
}

describe("formatTokens", () => {
  it.each([
    [0, "0"],
    [912, "912"],
    [85_000, "85.0K"],
    [320_400, "320K"],
    [1_120_000, "1.12M"],
    [28_400_000, "28.40M"],
    [500_000_000, "500M"],
    [1_940_000_000, "1.94B"],
  ])("%d → %s", (n, want) => {
    expect(formatTokens(n)).toBe(want);
  });
});

describe("formatUsd", () => {
  it.each([
    [0, "$0.00"],
    [0.00287, "$0.0029"],
    [0.1, "$0.10"],
    [6912.4, "$6,912.40"],
  ])("%d → %s", (n, want) => {
    expect(formatUsd(n)).toBe(want);
  });
});

describe("formatShare", () => {
  it.each([
    [412.18, 612.36, "67.3%"],
    [0.1, 612.36, "<0.1%"],
    [0, 10, "0.0%"],
    [1, 0, "—"],
  ])("%d of %d → %s", (part, whole, want) => {
    expect(formatShare(part, whole)).toBe(want);
  });
});

describe("modelColor", () => {
  it("gives the four slots their colours per scheme and anything else grey", () => {
    expect(modelColor("claude-opus-5-5", "dark")).toBe("#3987e5");
    expect(modelColor("claude-opus-5-5", "light")).toBe("#2a78d6");
    expect(modelColor("claude-fable-5-1", "dark")).toBe("#d95926");
    expect(modelColor("claude-sonnet-5-5", "light")).toBe("#1baf7a");
    expect(modelColor("claude-haiku-5-5", "dark")).toBe("#c98500");
    expect(modelColor("claude-opus-5", "dark")).toBe("oklch(0.6 0 0)");
    expect(modelColor("claude-opus-5", "light")).toBe("oklch(0.65 0 0)");
  });
});

describe("sumBuckets", () => {
  it("adds every counter, tokens over all five, and any unpriced bucket marks the total", () => {
    const t = sumBuckets([
      bucket({ requests: 2, input: 1, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5, costUsd: 0.5 }),
      bucket({ model: "claude-opus-5", requests: 1, input: 10, costUsd: 0, unpriced: true }),
    ]);
    expect(t).toEqual({ requests: 3, input: 11, output: 2, cacheRead: 3, cacheWrite5m: 4, cacheWrite1h: 5, tokens: 25, costUsd: 0.5, unpriced: true });
  });

  it("is zero for nothing", () => {
    expect(sumBuckets([])).toMatchObject({ requests: 0, tokens: 0, costUsd: 0, unpriced: false });
  });
});

describe("byModel", () => {
  it("groups per model across days, sorted by cost, then tokens", () => {
    const rows = byModel([
      bucket({ model: "claude-haiku-5-5", cacheRead: 3_000, costUsd: 0.1 }),
      bucket({ model: "claude-opus-5-5", cacheRead: 100, costUsd: 4, day: "2026-10-09" }),
      bucket({ model: "claude-opus-5-5", cacheRead: 100, costUsd: 4 }),
      bucket({ model: "claude-opus-5", cacheRead: 9_000, unpriced: true }),
      bucket({ model: "claude-x", cacheRead: 10, unpriced: true }),
    ]);
    expect(rows.map((r) => [r.model, r.requests, r.tokens, r.costUsd])).toEqual([
      ["claude-opus-5-5", 2, 200, 8],
      ["claude-haiku-5-5", 1, 3_000, 0.1],
      ["claude-opus-5", 1, 9_000, 0],
      ["claude-x", 1, 10, 0],
    ]);
  });
});
