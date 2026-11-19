import { describe, expect, it } from "vitest";
import { EMPTY_SELECTION, inOrder, pruneTo, rangeTo, toggleRow, type Selection } from "./sidebarSelection";

const order = ["a", "b", "c", "d", "e", "f"];
const sel = (ids: string[], anchor: string | null, base: string[] | null = null): Selection => ({ ids, anchor, base });

describe("toggleRow (cmd-click)", () => {
  it.each([
    { name: "nothing selected: just that row", from: EMPTY_SELECTION, id: "c", want: sel(["c"], "c") },
    { name: "adds a row and moves the anchor", from: sel(["a"], "a"), id: "d", want: sel(["a", "d"], "d") },
    { name: "removes a selected row, which stays the anchor", from: sel(["a", "d"], "d"), id: "a", want: sel(["d"], "a") },
    { name: "the last row off leaves nothing", from: sel(["a"], "a"), id: "a", want: sel([], "a") },
    { name: "ends an open range", from: sel(["b", "c", "d"], "b", []), id: "f", want: sel(["b", "c", "d", "f"], "f") },
  ])("$name", ({ from, id, want }) => {
    expect(toggleRow(from, id)).toEqual(want);
  });
});

describe("rangeTo (shift-click)", () => {
  it.each([
    { name: "from the anchor down, both included", from: sel(["b"], "b"), id: "d", fallback: null, want: sel(["b", "c", "d"], "b", ["b"]) },
    { name: "from the anchor up", from: sel(["e"], "e"), id: "c", fallback: null, want: sel(["e", "c", "d"], "e", ["e"]) },
    { name: "nothing selected: from the open thread", from: EMPTY_SELECTION, id: "d", fallback: "b", want: sel(["b", "c", "d"], "b", []) },
    { name: "nothing selected, no open thread: just the row", from: EMPTY_SELECTION, id: "d", fallback: null, want: sel(["d"], "d") },
    { name: "the open thread not shown: just the row", from: EMPTY_SELECTION, id: "d", fallback: "zz", want: sel(["d"], "d") },
    { name: "onto the anchor itself", from: sel(["c"], "c"), id: "c", fallback: null, want: sel(["c"], "c", ["c"]) },
    // Re-stretching: the previous range goes, the rows selected before it stay.
    { name: "a second shift-click replaces the range", from: sel(["b", "c", "d", "e"], "b", ["b"]), id: "c", fallback: null, want: sel(["b", "c"], "b", ["b"]) },
    { name: "and may cross the anchor", from: sel(["b", "c", "d"], "b", ["b"]), id: "a", fallback: null, want: sel(["b", "a"], "b", ["b"]) },
    { name: "cmd-picked rows outside the range stay", from: sel(["f", "b"], "b"), id: "d", fallback: null, want: sel(["f", "b", "c", "d"], "b", ["f", "b"]) },
    { name: "a row not shown changes nothing", from: sel(["b"], "b"), id: "zz", fallback: null, want: sel(["b"], "b") },
    // The anchor was removed with cmd-click: it still anchors (Finder).
    { name: "an anchor no longer selected still anchors", from: sel(["e"], "b"), id: "c", fallback: null, want: sel(["e", "b", "c"], "b", ["e"]) },
  ])("$name", ({ from, id, fallback, want }) => {
    expect(rangeTo(from, id, order, fallback)).toEqual(want);
  });
});

describe("pruneTo", () => {
  it.each([
    { name: "keeps what is shown, the same object", from: sel(["a", "c"], "c"), shown: order, want: sel(["a", "c"], "c"), same: true },
    { name: "a thread that left goes", from: sel(["a", "c"], "c"), shown: ["a", "b"], want: sel(["a"], null), same: false },
    { name: "from the range's base too", from: sel(["a", "b", "c"], "a", ["a", "x"]), shown: ["a", "b", "c"], want: sel(["a", "b", "c"], "a", ["a"]), same: false },
    { name: "nothing shown: nothing selected", from: sel(["a"], "a"), shown: [], want: sel([], null), same: false },
  ])("$name", ({ from, shown, want, same }) => {
    const got = pruneTo(from, shown);
    expect(got).toEqual(want);
    expect(got === from).toBe(same);
  });
});

describe("inOrder", () => {
  it("lists the selection in display order", () => {
    expect(inOrder(sel(["e", "a", "c"], "c"), order)).toEqual(["a", "c", "e"]);
    expect(inOrder(EMPTY_SELECTION, order)).toEqual([]);
  });
});
