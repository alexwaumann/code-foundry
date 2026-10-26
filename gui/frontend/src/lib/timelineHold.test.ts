import { describe, expect, it } from "vitest";
import { heldScroll, spacerAfterGrowth } from "./timelineHold";

describe("heldScroll", () => {
  const cases: { name: string; box: { scrollTop: number; contentHeight: number; clientHeight: number }; moved: number; want: { scrollTop: number; spacer: number } }[] = [
    // A card at the bottom shrank by 130: following the bottom moved its top down 130.
    { name: "shrink at the bottom needs a spacer", box: { scrollTop: 870, contentHeight: 1870, clientHeight: 1000 }, moved: 130, want: { scrollTop: 1000, spacer: 130 } },
    // The rows are now shorter than the box: the browser scrolled to 0, the spacer covers the rest.
    { name: "shrink below the box's height", box: { scrollTop: 0, contentHeight: 803, clientHeight: 830 }, moved: 103, want: { scrollTop: 103, spacer: 130 } },
    // Rows below it are taller than the shrink: no spacer.
    { name: "shrink with rows below", box: { scrollTop: 400, contentHeight: 3000, clientHeight: 1000 }, moved: 130, want: { scrollTop: 530, spacer: 0 } },
    // Growing back: the rows fill the box again and the spacer goes.
    { name: "grow back uses up the spacer", box: { scrollTop: 1000, contentHeight: 2000, clientHeight: 1000 }, moved: 0, want: { scrollTop: 1000, spacer: 0 } },
    { name: "grow a little keeps part of it", box: { scrollTop: 1000, contentHeight: 1920, clientHeight: 1000 }, moved: 0, want: { scrollTop: 1000, spacer: 80 } },
    // A card that grows while pinned moved up: put it back, its bottom goes under the fold.
    { name: "grow while pinned", box: { scrollTop: 1200, contentHeight: 2200, clientHeight: 1000 }, moved: -200, want: { scrollTop: 1000, spacer: 0 } },
    { name: "nothing moved", box: { scrollTop: 500, contentHeight: 1500, clientHeight: 1000 }, moved: 0, want: { scrollTop: 500, spacer: 0 } },
    { name: "never above the top", box: { scrollTop: 20, contentHeight: 1500, clientHeight: 1000 }, moved: -100, want: { scrollTop: 0, spacer: 0 } },
  ];
  for (const c of cases)
    it(c.name, () => {
      expect(heldScroll(c.box, c.moved)).toEqual(c.want);
    });
});

describe("spacerAfterGrowth", () => {
  it.each([
    [130, 1000, 1050, 80],
    [130, 1000, 1200, 0],
    [130, 1000, 900, 130],
    [0, 1000, 1100, 0],
  ])("spacer %d, rows %d → %d: %d", (spacer, from, to, want) => {
    expect(spacerAfterGrowth(spacer, from, to)).toBe(want);
  });
});
