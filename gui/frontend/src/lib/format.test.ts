import { describe, expect, it } from "vitest";
import { formatUptime } from "./format";

describe("formatUptime", () => {
  it.each([
    [0, "0s"],
    [12.9, "12s"],
    [249, "4m 9s"],
    [7500, "2h 5m"],
    [273600, "3d 4h"],
    [-5, "0s"],
  ])("formats %d seconds as %s", (input, want) => {
    expect(formatUptime(input)).toBe(want);
  });
});
