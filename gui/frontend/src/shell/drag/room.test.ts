/**
 * Which drops fit (docs/notes/shell-model.md, "Room for panes"; docs/notes/shell-25f-sizes.md).
 * internal/layout/testdata/drops.json holds `dropFits` to the daemon's refusals on random spaces
 * (drop.test.ts); these are the rules case by case.
 */
import { describe, expect, it } from "vitest";
import { col, pane, row } from "@/test/shellTrees";
import { dropFits, paneFitsInSpace, paneTakesAnyTab, raisesMinimum } from "./room";
import type { DragSource } from "./targets";

// A thread beside a diff: 480 + 12 + 480 = 972 wide, 400 tall.
const TWO = row("s-r", [0.5, 0.5], pane("p-a", "thread:A", "file:A"), pane("p-b", "diff:A"));
const tabFile: DragSource = { kind: "tab", tab: "p-a/1", pane: "p-a" };

describe("dropFits", () => {
  it("a split beside or onto the outer edge only where the result fits", () => {
    // Another column needs 1464 wide: not in 1200. Another row needs 812 tall: in 900, not in 800.
    for (const edge of ["left", "right"] as const) {
      expect(dropFits(TWO, tabFile, { kind: "edge", pane: "p-b", edge }, { w: 1200, h: 900 }), edge).toBe(false);
      expect(dropFits(TWO, tabFile, { kind: "outer", edge }, { w: 1200, h: 900 }), edge).toBe(false);
      expect(dropFits(TWO, tabFile, { kind: "edge", pane: "p-b", edge }, { w: 1464, h: 900 }), edge).toBe(true);
    }
    for (const edge of ["top", "bottom"] as const) {
      expect(dropFits(TWO, tabFile, { kind: "edge", pane: "p-b", edge }, { w: 1200, h: 900 }), edge).toBe(true);
      expect(dropFits(TWO, tabFile, { kind: "edge", pane: "p-b", edge }, { w: 1200, h: 800 }), edge).toBe(false);
    }
  });

  it("a pane moved beside another fits when its old place gives back the room", () => {
    // p-b leaves the row and goes under p-a: a column of 812 in 1000 x 900.
    expect(dropFits(TWO, { kind: "pane", pane: "p-b" }, { kind: "edge", pane: "p-a", edge: "bottom" }, { w: 600, h: 900 })).toBe(true);
  });

  it("a tab joining a pane fits always, unless it raises a pane of terminals' minimum past the room", () => {
    const terms = row("s-r", [0.6, 0.4], pane("p-a", "thread:A", "file:A"), pane("p-t", "terminal", "terminal"));
    const area = { w: 900, h: 800 };
    expect(dropFits(terms, tabFile, { kind: "pane", pane: "p-t" }, area)).toBe(false);
    expect(dropFits(terms, tabFile, { kind: "strip", pane: "p-t", index: 0 }, area)).toBe(false);
    expect(dropFits(terms, tabFile, { kind: "pane", pane: "p-t" }, { w: 972, h: 800 })).toBe(true);
    // A terminal joins it whatever the room.
    const withTerm = row("s-r", [0.6, 0.4], pane("p-a", "thread:A", "terminal:A"), pane("p-t", "terminal"));
    expect(dropFits(withTerm, { kind: "tab", tab: "p-a/1", pane: "p-a" }, { kind: "pane", pane: "p-t" }, area)).toBe(true);
    // A sidebar thread and a merged pane raise it as a tab does.
    expect(dropFits(terms, { kind: "thread", thread: "s-9" }, { kind: "pane", pane: "p-t" }, area)).toBe(false);
    // Any pane that is not all terminals takes anything (the minimum stays).
    expect(dropFits(terms, { kind: "pane", pane: "p-t" }, { kind: "pane", pane: "p-a" }, { w: 100, h: 100 })).toBe(true);
  });

  it("a collapsed pane takes any tab: the drop opens it, which is always allowed", () => {
    const terms = row("s-r", [0.6, 0.4], pane("p-a", "thread:A", "file:A"), { ...pane("p-t", "terminal"), collapsed: true });
    expect(dropFits(terms, tabFile, { kind: "pane", pane: "p-t" }, { w: 600, h: 500 })).toBe(true);
  });

  it("a collapsed pane costs only its rail: a split fits beside it", () => {
    const three = row("s-r", [0.4, 0.2, 0.4], pane("p-a", "thread:A", "file:A"), { ...pane("p-c", "prs"), collapsed: true }, pane("p-b", "diff:A"));
    // Open, a third column would need 1464; collapsed, the other two and the rail 1020; a fourth beside them 1512.
    expect(dropFits(three, tabFile, { kind: "edge", pane: "p-b", edge: "right" }, { w: 1500, h: 900 })).toBe(false);
    expect(dropFits(three, tabFile, { kind: "edge", pane: "p-b", edge: "right" }, { w: 1512, h: 900 })).toBe(true);
  });
});

describe("raisesMinimum", () => {
  it("only a pane of terminals, and only by a tab that is not one", () => {
    const terms = pane("p", "terminal");
    expect(raisesMinimum(terms, [{ id: "x", kind: "file" }])).toBe(true);
    expect(raisesMinimum(terms, [{ id: "x", kind: "terminal" }])).toBe(false);
    expect(raisesMinimum(pane("p", "terminal", "diff"), [{ id: "x", kind: "file" }])).toBe(false);
  });
});

describe("paneTakesAnyTab (the + menu of a pane of terminals)", () => {
  const terms = row("s-r", [0.6, 0.4], pane("p-a", "thread:A"), pane("p-t", "terminal"));
  it("no while the grown pane would not fit, yes once it would", () => {
    expect(paneTakesAnyTab(terms, "p-t", { w: 971, h: 800 })).toBe(false);
    expect(paneTakesAnyTab(terms, "p-t", { w: 972, h: 800 })).toBe(true);
  });
  it("any other pane, a collapsed one, or one not there: yes", () => {
    expect(paneTakesAnyTab(terms, "p-a", { w: 10, h: 10 })).toBe(true);
    expect(paneTakesAnyTab(row("s-r", [0.6, 0.4], pane("p-a", "thread:A"), { ...pane("p-t", "terminal"), collapsed: true }), "p-t", { w: 10, h: 10 })).toBe(true);
    expect(paneTakesAnyTab(terms, "p-x", { w: 10, h: 10 })).toBe(true);
    expect(paneTakesAnyTab(null, "p-t", { w: 10, h: 10 })).toBe(true);
  });
});

describe("paneFitsInSpace (a pane dropped on a space tab)", () => {
  const moved = pane("p-m", "file");
  it("goes right of the space's focused pane: refused where that would not fit", () => {
    const other = col("s-o", [0.5, 0.5], pane("p-x", "thread:X"), pane("p-y", "prs"));
    expect(paneFitsInSpace(other, "p-x", moved, { w: 971, h: 900 })).toBe(false);
    expect(paneFitsInSpace(other, "p-x", moved, { w: 972, h: 900 })).toBe(true);
  });
  it("an empty space, or a collapsed pane moved, fits", () => {
    expect(paneFitsInSpace(null, undefined, moved, { w: 10, h: 10 })).toBe(true);
    expect(paneFitsInSpace(pane("p-x", "thread:X"), "p-x", { ...moved, collapsed: true }, { w: 480 + 12 + 36, h: 400 })).toBe(true);
  });
});
