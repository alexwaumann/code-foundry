import { describe, expect, it } from "vitest";
import { fromOklch, oklchRgb, toOklch } from "@/themes/color";
import { C_MAX, editorLayout, maxChroma, parseHexInput } from "./model";

describe("parseHexInput", () => {
  it.each([
    ["#1a2b3c", false, "#1a2b3c"],
    ["1a2b3c", false, "#1a2b3c"],
    ["  #ABCDEF  ", false, "#abcdef"],
    ["#abc", false, "#aabbcc"],
    ["abc", false, "#aabbcc"],
    ["#1a2b3c80", true, "#1a2b3c80"],
    ["#1a2b3c80", false, null],
    ["#12345", false, null],
    ["rgb(10, 20, 30)", false, null],
    ["oklch(0.5 0.1 200)", false, null],
    ["", false, null],
  ] as const)("%j (tint %s) is %j", (raw, tint, want) => {
    expect(parseHexInput(raw, tint)).toBe(want);
  });
});

describe("maxChroma", () => {
  it("is the gamut edge: in sRGB at it, out just past it, and nothing at black and white", () => {
    for (const [l, h] of [
      [0.5, 249],
      [0.8, 90],
      [0.3, 20],
    ] as const) {
      const c = maxChroma(l, h);
      expect(c).toBeGreaterThan(0);
      expect(c).toBeLessThan(C_MAX);
      expect(oklchRgb(l, c, h)).not.toBeNull();
      expect(oklchRgb(l, c + 0.002, h)).toBeNull();
      // The colour emitted at the edge reads back with that chroma, so the fields agree with the hex.
      expect(toOklch(fromOklch(l, c, h))[1]).toBeCloseTo(c, 2);
    }
    // At lightness 0 a blue hue stays a blue black (the clipped .37 gave #010000, a red).
    expect(fromOklch(0, maxChroma(0, 249), 249)).toMatch(/^#0000[0-9a-f]{2}$/);
  });
});

describe("editorLayout", () => {
  // Body widths: the window less the sidebar (about 306px at the default sidebar width).
  it.each([
    [594, "strip", 296], // 900px window, its minimum
    [794, "strip", 296], // 1100
    [894, "strip", 296], // 1200
    [1134, "strip", 340], // 1440
    [1220, "full", 340],
    [500, "hidden", 296],
  ] as const)("a %ipx body: list %s, inspector %ipx", (width, list, inspector) => {
    const got = editorLayout(width);
    expect(got).toEqual({ list, inspector });
    // The edit bar and the gallery always keep at least 200px.
    const listWidth = { full: 240, strip: 56, hidden: 0 }[got.list];
    if (width >= 552) expect(width - listWidth - got.inspector).toBeGreaterThanOrEqual(200);
  });
});
