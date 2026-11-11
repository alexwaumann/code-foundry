/** A table cell's meter (docs/notes/plugin-table-meter.md): its fill, colour and label, pure. */
import { describe, expect, it } from "vitest";
import { METER_LABEL_MIN_CELL_PX, meterFill, meterFillClass, meterPercent, meterShowsLabel } from "./meter";

describe("meterFill", () => {
  it.each([
    { value: 0, want: { width: "0%", minWidth: 0 } },
    { value: 0.001, want: { width: "0.1%", minWidth: 2 } },
    { value: 0.41, want: { width: "41%", minWidth: 2 } },
    { value: 1, want: { width: "100%", minWidth: 2 } },
    // The daemon refuses these; drawn as empty or full, never past the track.
    { value: -0.5, want: { width: "0%", minWidth: 0 } },
    { value: 1.5, want: { width: "100%", minWidth: 2 } },
    { value: Number.NaN, want: { width: "0%", minWidth: 0 } },
  ])("$value fills $want.width", ({ value, want }) => {
    expect(meterFill(value)).toEqual(want);
  });
});

describe("meterPercent", () => {
  it.each([
    [0, 0],
    [0.004, 0],
    [0.375, 38],
    [0.86, 86],
    [1, 100],
    [2, 100],
  ])("%d is %d", (value, want) => {
    expect(meterPercent(value)).toBe(want);
  });
});

describe("meterShowsLabel", () => {
  it("is 96 px: a 48 px track, the 8 px gap and the 40 px slot", () => {
    expect(METER_LABEL_MIN_CELL_PX).toBe(96);
  });

  it.each([
    { name: "before the cell is measured", width: null, label: "86%", want: true },
    { name: "wide", width: 240, label: "86%", want: true },
    { name: "at the threshold", width: 96, label: "86%", want: true },
    { name: "a pixel under it", width: 95, label: "86%", want: false },
    { name: "narrow", width: 64, label: "3 of 8", want: false },
    { name: "no label", width: 240, label: undefined, want: false },
    { name: "an empty label", width: 240, label: "", want: false },
  ])("$name: $want", ({ width, label, want }) => {
    expect(meterShowsLabel({ value: 0.5, label }, width)).toBe(want);
  });
});

describe("meterFillClass", () => {
  it.each([
    { tone: undefined, want: "bg-cf-text/55" },
    { tone: "", want: "bg-cf-text/55" },
    { tone: "neutral", want: "bg-cf-text/55" },
    { tone: "ok", want: "bg-cf-success" },
    { tone: "attention", want: "bg-cf-warning" },
    { tone: "error", want: "bg-cf-error" },
    { tone: "muted", want: "bg-cf-text-muted" },
    { tone: "sparkly", want: "bg-cf-text/55" },
  ])("$tone is $want", ({ tone, want }) => {
    expect(meterFillClass(tone)).toBe(want);
  });
});
