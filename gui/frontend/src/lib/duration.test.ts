import { describe, expect, it } from "vitest";
import { formatAge, formatClock, formatDuration, type AgeUnits, type DurationUnits } from "./duration";

const S = 1_000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

const HMS: DurationUnits = { hours: true, minutes: true, seconds: true };
const ALL: DurationUnits = { days: true, ...HMS };

describe("formatDuration", () => {
  it.each<[string, number, DurationUnits, string]>([
    ["zero", 0, HMS, "0s"],
    ["under a second", 999, HMS, "0s"],
    ["seconds", 12 * S, HMS, "12s"],
    ["minutes and seconds", 4 * M + 8 * S, HMS, "4m 8s"],
    ["a zero second part is dropped", 4 * M, HMS, "4m"],
    ["hours and minutes, not seconds", H + 5 * M + 9 * S, HMS, "1h 5m"],
    ["hours past a day without days", 26 * H, HMS, "26h"],
    ["days and hours", 3 * D + 2 * H + 4 * M, ALL, "3d 2h"],
    ["rounded down", 59.9 * S, HMS, "59s"],
    ["negative counts as zero", -5 * S, HMS, "0s"],
    ["not a number counts as zero", Number.NaN, HMS, "0s"],
    ["without seconds, under a minute is 0m", 40 * S, { hours: true, minutes: true }, "0m"],
    ["without seconds", 4 * M + 8 * S, { hours: true, minutes: true }, "4m"],
    ["one unit", 3 * D + 5 * H, { days: true }, "3d"],
    ["tenths under 10 s", 4_250, { ...HMS, tenths: true }, "4.2s"],
    ["tenths at zero", 0, { ...HMS, tenths: true }, "0.0s"],
    ["whole seconds from 10 s", 42_700, { ...HMS, tenths: true }, "42s"],
    ["tenths need seconds", 4_250, { minutes: true, tenths: true }, "0m"],
    ["no units", 5 * S, {}, ""],
  ])("%s", (_, ms, units, want) => {
    expect(formatDuration(ms, units)).toBe(want);
  });
});

describe("formatAge", () => {
  const now = Date.UTC(2026, 10, 10, 12);
  const ALL_AGES: AgeUnits = { years: true, months: true, weeks: true, days: true, hours: true, minutes: true, seconds: true };
  const MHD: AgeUnits = { minutes: true, hours: true, days: true };

  it.each<[string, number, AgeUnits, string]>([
    ["under the smallest unit", 30 * S, MHD, "just now"],
    ["a future time", -5 * M, MHD, "just now"],
    ["seconds", 12 * S, ALL_AGES, "12s ago"],
    ["under a second", 400, ALL_AGES, "just now"],
    ["minutes", 4 * M + 50 * S, MHD, "4m ago"],
    ["hours", 3 * H + 59 * M, MHD, "3h ago"],
    ["days", 2 * D, MHD, "2d ago"],
    ["days past a week without weeks", 20 * D, MHD, "20d ago"],
    ["days until two weeks", 13 * D, ALL_AGES, "13d ago"],
    ["weeks from two", 14 * D, ALL_AGES, "2w ago"],
    ["weeks until two months", 59 * D, ALL_AGES, "8w ago"],
    ["months from two", 60 * D, ALL_AGES, "2mo ago"],
    ["years from one", 400 * D, ALL_AGES, "1y ago"],
    ["weeks as the smallest unit take over from one", 8 * D, { weeks: true }, "1w ago"],
    ["without ago", 5 * M, { ...MHD, ago: false }, "5m"],
    ["without ago, under the smallest unit", 5 * S, { ...MHD, ago: false }, "now"],
  ])("%s", (_, before, units, want) => {
    expect(formatAge(now - before, now, units)).toBe(want);
  });
});

describe("formatClock", () => {
  it.each([
    [0, "0:00"],
    [4_900, "0:04"],
    [12 * M + 5 * S, "12:05"],
    [H + 2 * M + 3 * S, "1:02:03"],
    [-S, "0:00"],
  ])("%d ms is %s", (ms, want) => {
    expect(formatClock(ms)).toBe(want);
  });
});
