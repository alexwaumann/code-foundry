import { describe, expect, it } from "vitest";
import type { CheckRollupView } from "@/api/gh";
import { checksSummary, freshness, monthName, prKey, repoName, reviewLabel, shortAge, updatedAgo } from "./format";

const NOW = new Date(2026, 9, 8, 12, 0, 0).getTime();
const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe("shortAge", () => {
  it.each([
    [null, "—"],
    [NOW - 10 * S, "now"],
    [NOW - 5 * M, "5m"],
    [NOW - 3 * H, "3h"],
    [NOW - 2 * D, "2d"],
    [NOW - 20 * D, "2w"],
    [NOW - 100 * D, "3mo"],
    [NOW - 800 * D, "2y"],
    [NOW + 5 * M, "now"],
  ])("%s -> %s", (ms, want) => {
    expect(shortAge(ms, NOW)).toBe(want);
  });
});

describe("updatedAgo and freshness", () => {
  it.each([
    [null, "not fetched yet"],
    [NOW - 8 * S, "updated 8s ago"],
    [NOW - 3 * M, "updated 3m ago"],
    [NOW - 2 * H, "updated 2h ago"],
  ])("%s -> %s", (ms, want) => {
    expect(updatedAgo(ms, NOW)).toBe(want);
  });
  it.each([
    [NOW - M, "", "fresh"],
    [NOW - 10 * M, "", "stale"],
    [NOW - M, "boom", "error"],
    [null, "", "never"],
  ] as const)("%s %s -> %s", (ms, err, want) => {
    expect(freshness(ms, err, NOW, 5 * M)).toBe(want);
  });
});

describe("checksSummary", () => {
  const r = (o: Partial<CheckRollupView>): CheckRollupView => ({ state: "success", total: 0, passed: 0, failed: 0, pending: 0, skipped: 0, ...o });
  it.each([
    [r({}), "none", "no checks"],
    [r({ total: 12, passed: 10, skipped: 2 }), "success", "12/12 passed"],
    [r({ state: "failure", total: 14, passed: 12, failed: 2 }), "failure", "2/14 failing"],
    [r({ state: "pending", total: 13, passed: 9, pending: 4 }), "pending", "4/13 pending"],
    [r({ state: "error", total: 1, passed: 1 }), "failure", "0/1 failing"],
  ])("%j", (c, tone, label) => {
    expect(checksSummary(c)).toEqual({ tone, label });
  });
});

describe("labels", () => {
  it("formats months, reviews, repos, keys", () => {
    expect(monthName("2026-10", NOW)).toBe("October");
    expect(monthName("2025-12", NOW)).toBe("December 2025");
    expect(monthName("", NOW)).toBe("—");
    expect(reviewLabel("changes_requested")).toBe("changes requested");
    expect(reviewLabel(null)).toBe("—");
    expect(repoName("o/name")).toBe("name");
    expect(prKey("merged", { repoSlug: "o/r", number: 7 })).toBe("merged:o/r#7");
  });
});
