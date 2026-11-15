import { describe, expect, it } from "vitest";
import type { LineRow } from "./topLine";
import { readerPlace } from "./readerPlace";

/** 19px rows from line `first`, the first starting at `top` (viewport px); the box is 100..500. */
function rows(first: number, top: number, count: number): LineRow[] {
  return Array.from({ length: count }, (_, i) => ({ line: first + i, top: top + i * 19, height: 19 }));
}

describe("where the reader is", () => {
  it("is the start of the first line whose top is on screen, zero-based", () => {
    expect(readerPlace(null, rows(700, 100, 30), 100, 500)).toEqual({ line: 699, character: 0 });
    // Line 700 cut off above: the caret goes on the next, whole one.
    expect(readerPlace(null, rows(700, 90, 30), 100, 500)).toEqual({ line: 700, character: 0 });
  });

  it("reads the rows in any order and skips rows not laid out", () => {
    const r = rows(10, 100, 5).reverse();
    r.push({ line: 3, top: 0, height: 0 });
    expect(readerPlace(null, r, 100, 500)).toEqual({ line: 9, character: 0 });
  });

  it("is the find's current match while it shows, at its start", () => {
    expect(readerPlace({ line: 714, start: 6, rect: { top: 385, bottom: 404 } }, rows(700, 100, 30), 100, 500)).toEqual({ line: 714, character: 6 });
  });

  it("is the first line when the match is off screen, cut off, or not rendered", () => {
    const shown = rows(700, 100, 30);
    expect(readerPlace({ line: 40, start: 2, rect: { top: -400, bottom: -381 } }, shown, 100, 500)).toEqual({ line: 699, character: 0 });
    expect(readerPlace({ line: 720, start: 2, rect: { top: 490, bottom: 509 } }, shown, 100, 500)).toEqual({ line: 699, character: 0 });
    expect(readerPlace({ line: 3000, start: 2, rect: null }, shown, 100, 500)).toEqual({ line: 699, character: 0 });
  });

  it("is a line cut off above when no top shows (one line taller than the box), and nothing with no rows", () => {
    expect(readerPlace(null, [{ line: 5, top: 50, height: 600 }], 100, 500)).toEqual({ line: 4, character: 0 });
    expect(readerPlace(null, [], 100, 500)).toBeNull();
    expect(readerPlace(null, rows(1, 600, 3), 100, 500)).toBeNull();
  });
});
