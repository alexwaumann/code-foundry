import { describe, expect, it } from "vitest";
import { topLineCorrection, topLineOf, type LineRow } from "./topLine";

/** A box from 100 to 500 (viewport px); 19px rows from line `first`, starting at `top`; `tall` lines take `rows` rows. */
function rows(first: number, top: number, count: number, tall: Readonly<Record<number, number>> = {}): LineRow[] {
  const out: LineRow[] = [];
  let y = top;
  for (let line = first; line < first + count; line++) {
    const height = 19 * (tall[line] ?? 1);
    out.push({ line, top: y, height });
    y += height;
  }
  return out;
}

describe("the line on top", () => {
  it("is the first row that shows, with how far it starts below the box (cut off above: negative)", () => {
    expect(topLineOf(rows(700, 90, 30), 100, 500, 1)).toEqual({ line: 700, offset: -10 });
    expect(topLineOf(rows(700, 100, 30), 100, 500, 1)).toEqual({ line: 700, offset: 0 });
  });

  it("skips a row that only touches the top, and a hidden one", () => {
    expect(topLineOf(rows(700, 81.5, 30), 100, 500, 1)?.line).toBe(701);
    expect(topLineOf([{ line: 5, top: 120, height: 0 }, ...rows(6, 120, 3)], 100, 500, 1)?.line).toBe(6);
  });

  it("measures the offset in layout px under a page zoom", () => {
    // At 125% a 19px row is 23.75 viewport px; 12.5 viewport px cut off is 10 layout px.
    expect(topLineOf([{ line: 704, top: 87.5, height: 23.75 }], 100, 500, 1.25)).toEqual({ line: 704, offset: -10 });
  });

  it("is null when no row shows", () => {
    expect(topLineOf([], 100, 500, 1)).toBeNull();
    expect(topLineOf(rows(1, 600, 3), 100, 500, 1)).toBeNull();
  });
});

describe("putting it back after the width changed", () => {
  const anchor = { line: 704, offset: -10 };

  it("scrolls by how far the line moved: down when a line above grew (re-wrapped narrower), up when it shrank", () => {
    // Line 651 wrapped into 3 rows instead of 2: everything under it moved down 19px.
    expect(topLineCorrection(anchor, [{ line: 704, top: 109, height: 19 }], 100, 1)).toBe(19);
    expect(topLineCorrection(anchor, [{ line: 704, top: 71, height: 19 }], 100, 1)).toBe(-19);
  });

  it("is 0 within half a pixel, and null while the line's row is not rendered", () => {
    expect(topLineCorrection(anchor, [{ line: 704, top: 90.3, height: 19 }], 100, 1)).toBe(0);
    expect(topLineCorrection(anchor, [{ line: 703, top: 71, height: 19 }], 100, 1)).toBeNull();
  });

  it("works in layout px under the new zoom", () => {
    // At 200% the line sits 20 viewport px (10 layout px) under where it was.
    expect(topLineCorrection(anchor, [{ line: 704, top: 100, height: 38 }], 100, 2)).toBe(10);
  });
});
