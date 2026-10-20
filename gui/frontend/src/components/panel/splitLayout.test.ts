import { describe, expect, it } from "vitest";
import { RATIO_DEFAULT, RATIO_MAX, RATIO_MIN } from "@/stores/panel";
import { PANEL_GROUP_MIN_HEIGHT, PANEL_MIN, PANEL_SIDE_BY_SIDE_MIN } from "@/stores/ui";
import { clampSplitRatio, dividerKeyRatio, groupMin, ratioBounds, splitOrientation, type SplitOrientation } from "./splitLayout";

describe("PANEL_SIDE_BY_SIDE_MIN", () => {
  it("is two group minimums, the divider and 24px of room", () => {
    expect(PANEL_SIDE_BY_SIDE_MIN).toBe(585);
  });
});

describe("splitOrientation", () => {
  it.each<[string, number, boolean, SplitOrientation]>([
    ["the minimum width stacks", PANEL_MIN, false, "stack"],
    ["the default width stacks", 420, false, "stack"],
    ["just under the threshold stacks", PANEL_SIDE_BY_SIDE_MIN - 1, false, "stack"],
    ["at the threshold, side by side", PANEL_SIDE_BY_SIDE_MIN, false, "side"],
    ["wide, side by side", 760, false, "side"],
    ["expanded, side by side whatever the stored width", 420, true, "side"],
    ["expanded at the minimum, side by side", PANEL_MIN, true, "side"],
  ])("%s", (_name, width, expanded, want) => {
    expect(splitOrientation(width, expanded)).toBe(want);
  });
});

describe("groupMin", () => {
  it("is PANEL_MIN wide side by side and PANEL_GROUP_MIN_HEIGHT tall stacked", () => {
    expect(groupMin("side")).toBe(PANEL_MIN);
    expect(groupMin("stack")).toBe(PANEL_GROUP_MIN_HEIGHT);
  });
});

describe("ratioBounds", () => {
  it.each<[string, number, number, { lo: number; hi: number }]>([
    ["plenty of room: the store's bounds", 2000, PANEL_MIN, { lo: RATIO_MIN, hi: RATIO_MAX }],
    ["a group minimum tighter than the store's", 700, PANEL_MIN, { lo: 0.4, hi: 0.6 }],
    ["exactly two minimums: only the middle", 560, PANEL_MIN, { lo: 0.5, hi: 0.5 }],
    ["less than two minimums: the default", 400, PANEL_MIN, { lo: RATIO_DEFAULT, hi: RATIO_DEFAULT }],
    ["no size (unmeasured): the default", 0, PANEL_MIN, { lo: RATIO_DEFAULT, hi: RATIO_DEFAULT }],
    ["NaN: the default", Number.NaN, PANEL_MIN, { lo: RATIO_DEFAULT, hi: RATIO_DEFAULT }],
    ["stacked, a tall panel", 800, PANEL_GROUP_MIN_HEIGHT, { lo: 0.2, hi: 0.8 }],
  ])("%s", (_name, size, min, want) => {
    const got = ratioBounds(size, min);
    expect(got.lo).toBeCloseTo(want.lo, 6);
    expect(got.hi).toBeCloseTo(want.hi, 6);
  });
});

describe("clampSplitRatio", () => {
  it.each<[string, number, number, number, number]>([
    ["inside the bounds, rounded to three places", 0.43219, 2000, PANEL_MIN, 0.432],
    ["below the store's minimum", 0.05, 2000, PANEL_MIN, RATIO_MIN],
    ["above the store's maximum", 0.97, 2000, PANEL_MIN, RATIO_MAX],
    ["below a group minimum", 0.2, 700, PANEL_MIN, 0.4],
    ["above a group minimum", 0.9, 700, PANEL_MIN, 0.6],
    ["no room: the default", 0.3, 400, PANEL_MIN, RATIO_DEFAULT],
  ])("%s", (_name, ratio, size, min, want) => {
    expect(clampSplitRatio(ratio, size, min)).toBeCloseTo(want, 6);
  });
});

describe("dividerKeyRatio", () => {
  it.each<[string, string, boolean, number, number | null]>([
    ["left moves towards the first group by 16px", "ArrowLeft", false, 0.5, 0.492],
    ["up does the same (stacked)", "ArrowUp", false, 0.5, 0.492],
    ["right moves away from it", "ArrowRight", false, 0.5, 0.508],
    ["down does the same", "ArrowDown", false, 0.5, 0.508],
    ["shift is four steps", "ArrowRight", true, 0.5, 0.532],
    ["clamped at the store's minimum", "ArrowLeft", true, 0.21, RATIO_MIN],
    ["home goes to the lower bound", "Home", false, 0.5, RATIO_MIN],
    ["end goes to the upper bound", "End", false, 0.5, RATIO_MAX],
    ["any other key is ignored", "Enter", false, 0.5, null],
    ["a letter is ignored", "a", false, 0.5, null],
  ])("%s", (_name, key, shift, ratio, want) => {
    const got = dividerKeyRatio(key, shift, ratio, 2000, PANEL_MIN);
    if (want === null) expect(got).toBeNull();
    else expect(got).toBeCloseTo(want, 6);
  });

  it("keeps each group at its minimum on a narrow split", () => {
    expect(dividerKeyRatio("Home", false, 0.5, 700, PANEL_MIN)).toBeCloseTo(0.4, 6);
    expect(dividerKeyRatio("End", false, 0.5, 700, PANEL_MIN)).toBeCloseTo(0.6, 6);
  });
});
