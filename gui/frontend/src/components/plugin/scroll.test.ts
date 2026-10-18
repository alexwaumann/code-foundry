import { describe, expect, it } from "vitest";
import { fadeMask, overflowEdges, scrollLeftToShow } from "./scroll";

describe("view tab overflow", () => {
  it.each([
    [0, 200, 200, { start: false, end: false }],
    [0, 200, 400, { start: false, end: true }],
    [100, 200, 400, { start: true, end: true }],
    [200, 200, 400, { start: true, end: false }],
    [0.5, 200, 200.6, { start: false, end: false }],
  ])("scrollLeft %d of %d/%d -> %o", (left, client, scroll, want) => {
    expect(overflowEdges(left, client, scroll)).toEqual(want);
  });

  it("fades only the sides with more", () => {
    expect(fadeMask(false, false)).toBeUndefined();
    expect(fadeMask(false, true)).toBe("linear-gradient(to right, black 0, black calc(100% - 24px), transparent 100%)");
    expect(fadeMask(true, false)).toBe("linear-gradient(to right, transparent 0, black 24px, black 100%)");
  });

  it("scrolls as little as it can to show the active tab", () => {
    expect(scrollLeftToShow(0, 200, 50, 40)).toBe(0);
    expect(scrollLeftToShow(0, 200, 250, 40)).toBe(114);
    expect(scrollLeftToShow(150, 200, 60, 40)).toBe(36);
    // The first tab (inside the strip's 2 px padding) scrolls all the way back.
    expect(scrollLeftToShow(80, 200, 2, 40)).toBe(0);
  });
});
