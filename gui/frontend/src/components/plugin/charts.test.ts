import { describe, expect, it } from "vitest";
import { tooltipStyle } from "@/components/charts/tooltip";
import {
  BAR_MAX_WIDTH,
  BAR_MIN_HEIGHT,
  BAR_PLOT_HEIGHT,
  barAt,
  barGeometry,
  barHeight,
  barOpacity,
  barPaint,
  barScaleTop,
  barValueY,
  figureEm,
  figureRole,
  nextBar,
  STATS_DISPLAY_WIDTH,
  statCardWidth,
  statsColumns,
  statToneClass,
} from "./charts";

describe("statsColumns", () => {
  it.each([
    // [width, cards, columns]
    [null, 4, 4], // until the first measure, one row
    [1000, 4, 4],
    [1000, 6, 6],
    [436, 4, 4], // 4 × 100 + 3 × 12
    [435, 4, 2], // two by two, not 3 + 1
    [386, 3, 3], // the side panel (386 px at its default width) holds three
    [324, 3, 3], // 3 × 100 + 2 × 12
    [323, 3, 2],
    [330, 5, 3], // three and two
    [330, 6, 3], // three by two
    [224, 6, 2],
    [211, 6, 1], // below two cards a row: one
    [80, 2, 1], // narrower than one card: still one a row
    [500, 1, 1],
    [500, 0, 1],
  ])("%s px, %i cards: %i a row", (width, n, want) => {
    expect(statsColumns(width, n)).toBe(want);
  });
});

describe("figureRole", () => {
  it("is display where the cards are roomy, title in the side panel, heading when that is cut", () => {
    // The expanded panel's four cards (about 1100 px): display.
    expect(figureRole(1100, statCardWidth(1100, 4), ["86%", "4m 12s", "2", "1"])).toBe("text-display-sm");
    // The side panel at its default width (386 px): two by two or three in a row, title.
    expect(figureRole(386, statCardWidth(386, 2), ["86%", "4m 12s", "4", "1"])).toBe("text-title");
    expect(figureRole(386, statCardWidth(386, 3), ["86%", "4m 12s", "4"])).toBe("text-title");
    // Three in a 330 px panel: 102 px cards, too narrow for "4m 12s" in title.
    expect(figureRole(330, statCardWidth(330, 3), ["86%", "4m 12s", "4"])).toBe("text-heading");
    // Short figures keep title there.
    expect(figureRole(330, statCardWidth(330, 3), ["86%", "12", "4"])).toBe("text-title");
  });

  it("keeps display for a row at least 560 px wide, however roomy its cards", () => {
    expect(figureRole(STATS_DISPLAY_WIDTH, 400, ["1"])).toBe("text-display-sm");
    expect(figureRole(STATS_DISPLAY_WIDTH - 1, 400, ["1"])).toBe("text-title");
  });

  it("takes one role for the row from its widest value", () => {
    expect(figureRole(600, 200, ["1"])).toBe("text-display-sm");
    expect(figureRole(600, 200, ["1", "12,345,678"])).toBe("text-title");
  });

  it("falls back to heading when nothing fits (the value is then cut)", () => {
    expect(figureRole(600, 100, ["x".repeat(24)])).toBe("text-heading");
  });

  it("estimates from measured advances: digits wider than spaces, m wider than s", () => {
    expect(figureEm("4m 12s")).toBeCloseTo(0.56 + 0.85 + 0.25 + 0.56 + 0.56 + 0.55);
    expect(figureEm("")).toBe(0);
  });
});

describe("statToneClass", () => {
  it.each([
    ["ok", "text-cf-success-text"],
    ["attention", "text-cf-warning-text"],
    ["error", "text-cf-error-text"],
    ["muted", "text-cf-text-muted"],
    ["", ""],
    [undefined, ""],
    ["neutral", ""], // pluginsdk/ui accepts "neutral" for ""
    ["sparkly", ""], // a newer plugin's tone reads neutral
  ])("%s → %s", (tone, want) => {
    expect(statToneClass(tone)).toBe(want);
  });
});

describe("barGeometry", () => {
  it("shares the width in slots, a fifth of each a gap", () => {
    const g = barGeometry(300, 30);
    expect(g.slot).toBe(10);
    expect(g.barWidth).toBe(8);
    expect(g.x(0)).toBe(1);
    expect(g.x(29)).toBe(291);
  });

  it("keeps 120 bars visible in the side panel: no gap below 3 px slots", () => {
    const g = barGeometry(330, 120);
    expect(g.slot).toBeCloseTo(2.75);
    expect(g.barWidth).toBeCloseTo(2.75);
  });

  it("caps a bar at 40 px, centred in its slot", () => {
    const g = barGeometry(1000, 4);
    expect(g.barWidth).toBe(BAR_MAX_WIDTH);
    expect(g.x(0)).toBe((250 - BAR_MAX_WIDTH) / 2);
  });

  it("has no NaN for an empty chart", () => {
    const g = barGeometry(300, 0);
    expect(Number.isFinite(g.barWidth) && Number.isFinite(g.x(0))).toBe(true);
  });
});

describe("bar heights", () => {
  it("scales to the largest bar or the reference, whichever is higher", () => {
    expect(barScaleTop({ bars: [{ key: "a", title: "a", value: 3 }], reference: { value: 10 } })).toBe(10);
    expect(barScaleTop({ bars: [{ key: "a", title: "a", value: 30 }], reference: { value: 10 } })).toBe(30);
    expect(barScaleTop({ bars: [] })).toBe(0);
  });

  it("draws a zero (and an all-zero chart) at the least height, never more than the plot", () => {
    expect(barHeight(0, 100)).toBe(BAR_MIN_HEIGHT);
    expect(barHeight(5, 0)).toBe(BAR_MIN_HEIGHT);
    expect(barHeight(100, 100)).toBe(BAR_PLOT_HEIGHT);
    expect(barHeight(50, 100)).toBe(BAR_PLOT_HEIGHT / 2);
    expect(barHeight(Number.NaN, 100)).toBe(BAR_MIN_HEIGHT);
  });

  it("puts the reference line on the bars' scale", () => {
    expect(barValueY(50, 100)).toBe(BAR_PLOT_HEIGHT / 2);
    expect(barValueY(100, 100)).toBe(0);
    expect(barValueY(0, 0)).toBe(BAR_PLOT_HEIGHT);
  });
});

describe("barPaint", () => {
  it.each([
    ["ok", "fill-cf-success"],
    ["failed", "fill-cf-error"],
    ["attention", "fill-cf-warning"],
    ["running", "fill-cf-info"],
    ["pending", "fill-cf-text-muted"],
    ["skipped", "fill-cf-text-muted"],
    ["off", "fill-cf-text-muted"],
  ] as const)("a %s bar is %s", (status, fill) => {
    const p = barPaint({ status });
    expect(p.className.split(" ")).toContain(fill);
    expect(p.hollow).toBe(status === "running");
    expect(p.style).toBeUndefined();
  });

  it("colours a bar without a status by its series in the chart palette (1 by default)", () => {
    expect(barPaint({ series: 3 }).style).toEqual({ "--sw-l": "#1baf7a", "--sw-d": "#199e70" });
    expect(barPaint({}).style).toEqual({ "--sw-l": "#2a78d6", "--sw-d": "#3987e5" });
    expect(barPaint({ series: 9 }).style).toEqual(barPaint({ series: 1 }).style);
    expect(barPaint({ series: 2 }).className).toContain("dark:fill-(--sw-d)");
  });

  it("dims every bar but the highlighted one; a hollow bar's fill stays faint", () => {
    expect(barOpacity(false, 2, null)).toBe(0.85);
    expect(barOpacity(false, 2, 2)).toBe(0.85);
    expect(barOpacity(false, 1, 2)).toBeCloseTo(0.34);
    expect(barOpacity(true, 2, null)).toBe(0.3);
    expect(barOpacity(true, 1, 2)).toBeCloseTo(0.12);
  });
});

describe("nextBar", () => {
  it.each([
    [null, "ArrowRight", 5, 4], // the first key shows the newest bar
    [null, "ArrowLeft", 5, 4],
    [2, "ArrowRight", 5, 3],
    [2, "ArrowLeft", 5, 1],
    [4, "ArrowRight", 5, 4], // stops at the ends
    [0, "ArrowLeft", 5, 0],
    [3, "Home", 5, 0],
    [1, "End", 5, 4],
    [2, "ArrowDown", 5, null], // the page scrolls
    [2, "a", 5, null],
    [null, "Home", 0, null],
  ])("from %s, %s among %i → %s", (from, key, n, want) => {
    expect(nextBar(from, key, n)).toBe(want);
  });
});

describe("barAt", () => {
  it("finds the slot under the pointer, clamped to the bars", () => {
    expect(barAt(0, 300, 30)).toBe(0);
    expect(barAt(15, 300, 30)).toBe(1);
    expect(barAt(299.9, 300, 30)).toBe(29);
    expect(barAt(400, 300, 30)).toBe(29);
    expect(barAt(-5, 300, 30)).toBe(0);
  });
});

describe("tooltipStyle", () => {
  it("goes right of a bar in the left half and left of one in the right half", () => {
    expect(tooltipStyle(2, 30, 25, 300, -6, 10)).toEqual({ left: 35, top: -6 });
    expect(tooltipStyle(20, 30, 205, 300, -6, 10)).toEqual({ right: 105, top: -6 });
  });

  it("fits the room on its side when asked, below the usual least width in a narrow plot", () => {
    expect(tooltipStyle(14, 30, 145, 300, 0, 10, true)).toEqual({ left: 155, top: 0, maxWidth: 145, minWidth: 145 });
    expect(tooltipStyle(2, 30, 25, 600, 0, 10, true)).toEqual({ left: 35, top: 0, maxWidth: 565, minWidth: 160 });
  });
});
