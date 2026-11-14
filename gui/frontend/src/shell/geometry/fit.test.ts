/**
 * The one fit function (docs/notes/shell-model.md, "Room for panes"; docs/notes/shell-25f-sizes.md):
 * the window's `minimumOf` and `treeFits` give the daemon's answers (internal/layout fit.go
 * MinimumOf, Fits) on Go's own random cases.
 */
import { describe, expect, it } from "vitest";
import fixture from "../../../../../internal/layout/testdata/fits.json?raw";
import { col, pane, row } from "@/test/shellTrees";
import { foldRails } from "./rails";
import { GUTTER, RAIL, minimumOf, treeFits } from "./rects";
import { collapsedOf, type GeoNode, type Size } from "./types";

interface FitCase {
  root: GeoNode;
  w: number;
  h: number;
  min: Size;
  fits: boolean;
}

const cases = JSON.parse(fixture) as FitCase[];

describe("treeFits against internal/layout's Fits (testdata/fits.json)", () => {
  it("reads the cases: both answers, panes of terminals and collapsed panes among them", () => {
    expect(cases.length).toBe(60);
    expect(cases.some((c) => c.fits) && cases.some((c) => !c.fits)).toBe(true);
    expect(cases.some((c) => collapsedOf(c.root).size > 0)).toBe(true);
  });

  it.each(cases.map((c, i) => [i, c] as const))("case %i", (_i, c) => {
    expect(minimumOf(c.root)).toEqual(c.min);
    expect(treeFits(c.root, c.w, c.h)).toBe(c.fits);
  });

  it.each(cases.filter((c) => c.root.t === "split").map((c, i) => [i, c] as const))("fits exactly when nothing would fold automatically: case %i", (_i, c) => {
    // "Fits" means the result needs no automatic fold: foldRails then folds only the collapsed panes.
    const rails = foldRails({ root: c.root, w: c.w, h: c.h });
    expect(rails.size === collapsedOf(c.root).size).toBe(c.fits);
  });
});

describe("treeFits", () => {
  it.each<[string, GeoNode | null, number, number, boolean]>([
    ["nothing", null, 10, 10, true],
    ["one pane, however small the area", pane("a", "thread:a"), 100, 100, true],
    ["two in a row, exactly", row("s", [0.5, 0.5], pane("a", "thread:a"), pane("b", "diff")), 480 + GUTTER + 480, 400, true],
    ["two in a row, a px short", row("s", [0.5, 0.5], pane("a", "thread:a"), pane("b", "diff")), 480 + GUTTER + 479, 400, false],
    ["a terminal's pane beside a thread", row("s", [0.9, 0.1], pane("a", "thread:a"), pane("b", "terminal")), 480 + GUTTER + 300, 400, true],
    ["a column of a thread over a terminal", col("s", [0.5, 0.5], pane("a", "thread:a"), pane("b", "terminal")), 480, 400 + GUTTER + 220, true],
    ["a collapsed pane costs its rail", row("s", [0.3, 0.3, 0.4], pane("a", "thread:a"), { ...pane("b", "diff"), collapsed: true }, pane("c", "prs")), 480 + RAIL + 480 + 2 * GUTTER, 400, true],
    ["three open in a row in 1440 less the sidebar", row("s", [0.3, 0.3, 0.4], pane("a", "thread:a"), pane("b", "diff"), pane("c", "prs")), 1180, 800, false],
  ])("%s: %s", (_name, root, w, h, want) => {
    expect(treeFits(root, w, h)).toBe(want);
  });

  it("does not depend on the proportions", () => {
    const a = row("s", [0.95, 0.05], pane("a", "thread:a"), pane("b", "diff"));
    const b = row("s", [0.05, 0.95], pane("a", "thread:a"), pane("b", "diff"));
    expect(treeFits(a, 972, 400)).toBe(true);
    expect(treeFits(b, 972, 400)).toBe(true);
  });
});
