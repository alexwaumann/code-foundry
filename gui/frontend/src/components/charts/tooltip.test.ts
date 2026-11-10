import { describe, expect, it } from "vitest";
import { tooltipSide } from "./tooltip";

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
