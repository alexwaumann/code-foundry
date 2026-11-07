import { describe, expect, it } from "vitest";
import { followOpen, gridColumns, gridRow, singleKey } from "./layout";

describe("gridColumns", () => {
  it.each([
    [0, 2],
    [280, 2],
    [360, 2],
    [460, 2],
    [700, 3],
    [1400, 6],
  ])("a box %d px wide has %d", (width, columns) => {
    expect(gridColumns(width)).toBe(columns);
  });
});

describe("gridRow", () => {
  it("gives a tile the shape of a screen and a row room for its caption", () => {
    expect(gridRow(360, 2)).toEqual({ tile: 101, row: 139 });
  });

  it("never has a tile with no height", () => {
    expect(gridRow(0, 2).tile).toBe(1);
  });
});

describe("singleKey", () => {
  it.each([
    ["arrowright", 1, 3, 2],
    ["arrowdown", 1, 3, 2],
    ["arrowleft", 1, 3, 0],
    ["arrowup", 1, 3, 0],
    ["arrowright", 2, 3, 2],
    ["arrowleft", 0, 3, 0],
    ["escape", 1, 3, "grid"],
    ["alt+arrowleft", 1, 3, null],
    ["a", 1, 3, null],
  ])("%s at %d of %d gives %j", (chord, at, count, want) => {
    expect(singleKey(chord, at, count)).toBe(want);
  });
});

describe("followOpen", () => {
  const image = (path: string) => ({ path, caption: "", stamp: 0 });
  const before = [image("/a.png"), image("/b.png")];

  it("stays on the file, wherever the new list has it", () => {
    expect(followOpen(before, [image("/c.png"), image("/b.png")], 1)).toBe(1);
    expect(followOpen(before, [image("/b.png"), image("/a.png")], 1)).toBe(0);
  });

  it("goes back to the grid when the file is gone, and stays there", () => {
    expect(followOpen(before, [image("/c.png")], 1)).toBeNull();
    expect(followOpen(before, before, null)).toBeNull();
  });
});
