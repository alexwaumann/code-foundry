import { describe, expect, it } from "vitest";
import { col, pane, randomTree, rng, row } from "@/test/shellTrees";
import { foldOrder, foldRails, shellFrame, unfoldable, type RailsInput } from "./rails";
import { RAIL, minimumOf, tilingErrors } from "./rects";
import { panesOf, type GeoNode } from "./types";

/** Freezes a tree all the way down, so any write to the stored layout throws. */
function frozen<T>(v: T): T {
  if (v && typeof v === "object") {
    Object.values(v).forEach(frozen);
    Object.freeze(v);
  }
  return v;
}

const sorted = (s: Set<string>) => [...s].sort();

// a: thread A (360), b: A's diff (260), c: Pull Requests (300), d: thread B (360). 1316 x 220.
const four = frozen(
  row("s", [0.25, 0.25, 0.25, 0.25], pane("a", "thread:A"), pane("b", "diff:A"), pane("c", "prs"), pane("d", "thread:B")),
);
const fourAt = (w: number, extra: Partial<RailsInput> = {}): RailsInput => ({
  root: four,
  w,
  h: 600,
  focus: "a",
  mru: ["a/0", "d/0", "b/0"],
  ...extra,
});

describe("fold order", () => {
  it("panes without a thread tab first, least recently focused first, never-focused before any", () => {
    expect(foldOrder(four, "a", ["a/0", "d/0", "b/0"])).toEqual(["c", "b", "d"]);
    expect(foldOrder(four, "a", ["a/0", "b/0", "c/0", "d/0"])).toEqual(["c", "b", "d"]);
    expect(foldOrder(four, "a", ["c/0", "b/0", "a/0", "d/0"])).toEqual(["b", "c", "d"]);
  });

  it("a pane is as recent as its most recently focused tab", () => {
    const tree = row("s", [0.5, 0.25, 0.25], pane("a", "thread:A"), pane("b", "prs", "projects"), pane("c", "diff"));
    expect(foldOrder(tree, "a", ["b/1", "c/0", "b/0"])).toEqual(["c", "b"]);
  });

  it("panes never focused fold later ones in layout order first", () => {
    const tree = row("s", [0.4, 0.2, 0.2, 0.2], pane("a", "thread:A"), pane("b", "prs"), pane("c", "projects"), pane("d", "diff"));
    expect(foldOrder(tree, "a", [])).toEqual(["d", "c", "b"]);
  });

  it("panes with thread tabs fold after every pane without, whatever their recency", () => {
    const tree = row("s", [0.4, 0.3, 0.3], pane("a", "thread:A"), pane("b", "thread:B", "diff:B"), pane("c", "prs"));
    expect(foldOrder(tree, "a", ["c/0", "a/0"])).toEqual(["c", "b"]);
  });
});

describe("never folds", () => {
  it("the focused pane", () => {
    expect(sorted(unfoldable(four, "c"))).toEqual(["c"]);
  });

  it("the pane of the focused thread, when the focus is on its own tab", () => {
    expect(sorted(unfoldable(four, "a"))).toEqual(["a"]);
  });

  it("the pane of the focused thread, when the focus is on one of its linked surfaces", () => {
    expect(sorted(unfoldable(four, "b"))).toEqual(["a", "b"]);
    expect(foldOrder(four, "b", [])).toEqual(["c", "d"]);
  });

  it("nothing when no pane is focused", () => {
    expect(sorted(unfoldable(four, undefined))).toEqual([]);
    expect(sorted(unfoldable(four, "p-gone"))).toEqual([]);
  });

  it("not even when the window cannot hold them", () => {
    const rails = foldRails(fourAt(300, { focus: "b" }));
    expect(sorted(rails)).toEqual(["c", "d"]);
    const frame = shellFrame(fourAt(300, { focus: "b" }));
    expect(frame.rects.a?.rail).toBe(false);
    expect(frame.rects.b?.rail).toBe(false);
    expect(tilingErrors(frame)).toEqual([]);
  });
});

describe("folding", () => {
  it.each([
    { w: 1400, want: [] },
    { w: 1316, want: [] },
    { w: 1315, want: ["c"] },
    { w: 1100, want: ["c"] },
    { w: 900, want: ["b", "c"] },
    { w: 700, want: ["b", "c", "d"] },
    { w: 400, want: ["b", "c", "d"] },
  ])("at $w px wide: $want", ({ w, want }) => {
    expect(sorted(foldRails(fourAt(w)))).toEqual(want);
    const frame = shellFrame(fourAt(w));
    expect(tilingErrors(frame)).toEqual([]);
    for (const id of want) expect(frame.rects[id]?.w).toBe(RAIL);
  });

  it("unfolds when there is room again: the rails come from the area alone", () => {
    const input = fourAt(900);
    expect(sorted(foldRails(input))).toEqual(["b", "c"]);
    expect(sorted(foldRails({ ...input, w: 1100 }))).toEqual(["c"]);
    expect(sorted(foldRails({ ...input, w: 1600 }))).toEqual([]);
  });

  it("never changes the stored layout", () => {
    const before = JSON.stringify(four);
    expect(() => shellFrame(fourAt(500))).not.toThrow();
    expect(JSON.stringify(four)).toBe(before);
  });

  it("keeps a fold only when it shrinks a dimension that does not fit", () => {
    // c folds first (never focused) but the column stays as wide as b, so it unfolds again.
    const tree = row("s", [0.5, 0.5], pane("a", "thread:A"), col("k", [0.5, 0.5], pane("b", "prs"), pane("c", "terminal")));
    expect(minimumOf(tree)).toEqual({ w: 672, h: 282 });
    expect(sorted(foldRails({ root: tree, w: 612, h: 600, focus: "a", mru: ["b/0"] }))).toEqual(["b"]);
  });

  it("folds for height as well as width", () => {
    const tree = col("s", [0.5, 0.25, 0.25], pane("a", "thread:A"), pane("b", "terminal"), pane("c", "diff"));
    expect(minimumOf(tree).h).toBe(220 + 110 + 150 + 24);
    const input = { root: tree, w: 800, h: 400, focus: "a", mru: ["a/0", "b/0", "c/0"] };
    expect(sorted(foldRails(input))).toEqual(["c"]);
    expect(shellFrame(input).rects.c).toEqual({ x: 0, y: 364, w: 800, h: RAIL, rail: true });
  });

  it("unfolds an earlier fold a later one made unnecessary", () => {
    // The terminal folds first and saves 204px, not enough; thread B then saves 324px alone.
    const tree = row("s", [0.4, 0.2, 0.4], pane("a", "thread:A"), pane("t", "terminal"), pane("u", "thread:B"));
    expect(foldOrder(tree, "a", [])).toEqual(["t", "u"]);
    expect(sorted(foldRails({ root: tree, w: 700, h: 600, focus: "a" }))).toEqual(["u"]);
  });

  it("folds nothing for an empty space", () => {
    expect(sorted(foldRails({ root: null, w: 10, h: 10 }))).toEqual([]);
  });
});

describe("random trees", () => {
  it("keep the unfoldable panes, tile the area, and unfold every rail that could", () => {
    const rand = rng(23);
    for (let n = 0; n < 300; n++) {
      const root: GeoNode = frozen(randomTree(rand, 2));
      const panes = panesOf(root);
      const focus = panes[Math.floor(rand() * panes.length)]?.id;
      const mru = panes.flatMap((p) => (p.tabs ?? []).map((t) => t.id)).filter(() => rand() < 0.5);
      const min = minimumOf(root);
      const w = Math.max(400, Math.round(min.w * (0.4 + rand() * 0.8)));
      const h = Math.max(400, Math.round(min.h * (0.4 + rand() * 0.8)));
      const input = { root, w, h, focus, mru };
      const rails = foldRails(input);
      for (const id of unfoldable(root, focus)) expect(rails.has(id), `tree ${String(n)}: ${id} folded`).toBe(false);
      const frame = shellFrame(input);
      expect(tilingErrors(frame), `tree ${String(n)} at ${String(w)}x${String(h)}`).toEqual([]);
      const fits = (s: { w: number; h: number }) => s.w <= w && s.h <= h;
      if (fits(minimumOf(root, rails))) {
        for (const id of rails) {
          const without = new Set(rails);
          without.delete(id);
          expect(fits(minimumOf(root, without)), `tree ${String(n)}: ${id} could unfold`).toBe(false);
        }
      }
    }
  });
});
