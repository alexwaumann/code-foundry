import { describe, expect, it } from "vitest";
import { formatCountdown, formatDuration, formatFixedDuration, formatRelative, formatTime } from "./format";

describe("plugin time formats", () => {
  it.each([
    [0, "0s"],
    [42_000, "42s"],
    [252_000, "4m 12s"],
    [3_840_000, "1h 4m"],
    [183_600_000, "2d 3h"],
    [-5, "0s"],
  ])("duration %d ms is %s", (ms, want) => {
    expect(formatDuration(ms)).toBe(want);
  });

  it.each([
    [0, "0s"],
    [40, "<0.1s"],
    [108, "0.1s"],
    [2_390, "2.3s"],
    [9_999, "9.9s"],
    [14_000, "14s"],
    [252_000, "4m 12s"],
  ])("fixed duration %d ms is %s", (ms, want) => {
    expect(formatFixedDuration(ms)).toBe(want);
  });

  it.each([
    [0, "just now"],
    [-12_000, "12s ago"],
    [-300_000, "5m ago"],
    [-3 * 3_600_000, "3h ago"],
    [-86_400_000, "1 day ago"],
    [12_000, "in 12s"],
    [3 * 86_400_000, "in 3 days"],
  ])("relative %d ms is %s", (d, want) => {
    expect(formatRelative(1_000_000_000 + d, 1_000_000_000)).toBe(want);
  });

  it("counts down, then says expired", () => {
    expect(formatCountdown(581_000, 0)).toBe("9:41");
    expect(formatCountdown(3_723_000, 0)).toBe("1:02:03");
    expect(formatCountdown(0, 0)).toBe("expired");
  });

  it("formats a time span by style; one that does not parse is empty", () => {
    const at = new Date(1_000_000).toISOString();
    expect(formatTime(at, "elapsed", 1_252_000)).toBe("4m 12s");
    expect(formatTime(at, undefined, 1_060_000)).toBe("1m ago");
    expect(formatTime("nope", "relative", 0)).toBe("");
  });
});
