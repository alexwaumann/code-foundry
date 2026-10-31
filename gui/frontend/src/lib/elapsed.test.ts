import { describe, expect, it } from "vitest";
import { elapsedTickMs, formatElapsed } from "./elapsed";

const NOW = Date.UTC(2026, 9, 31, 12, 0, 0);
const S = 1_000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe("formatElapsed", () => {
  it.each<[string, number, string]>([
    ["now", 0, "0s"],
    ["in the future", -5 * S, "0s"],
    ["under a second", 999, "0s"],
    ["seconds", 4 * S, "4s"],
    ["seconds rounded down", 4 * S + 900, "4s"],
    ["last second", 59 * S + 999, "59s"],
    ["a minute", M, "1m"],
    ["minutes", 4 * M + 30 * S, "4m"],
    ["last minute", 59 * M + 59 * S, "59m"],
    ["an hour", H, "1h"],
    ["an hour and seconds", H + 59 * S, "1h"],
    ["hours and minutes", H + 4 * M, "1h 4m"],
    ["last hour", 23 * H + 59 * M + 59 * S, "23h 59m"],
    ["a day", D, "1d"],
    ["days", 3 * D + 5 * H, "3d"],
    ["many days", 400 * D, "400d"],
  ])("%s", (_name, ago, want) => {
    expect(formatElapsed(NOW - ago, NOW)).toBe(want);
  });
});

describe("elapsedTickMs", () => {
  it.each<[string, number, number]>([
    ["now", 0, S],
    ["in the future", -5 * S, S],
    ["seconds", 30 * S, S],
    ["last second", 59 * S + 999, S],
    ["a minute", M, M],
    ["hours", 2 * H, M],
    ["days", 3 * D, M],
  ])("%s", (_name, ago, want) => {
    expect(elapsedTickMs(NOW - ago, NOW)).toBe(want);
  });
});
