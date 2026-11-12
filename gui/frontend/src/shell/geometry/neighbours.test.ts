import { describe, expect, it } from "vitest";
import { col, pane, row } from "@/test/shellTrees";
import { DIRECTIONS, neighbour, neighbours } from "./neighbours";
import { shellFrame } from "./rails";
import { plainRects } from "./rects";

describe("neighbours", () => {
  // a | b
  // --+--
  // c | d
  const grid = plainRects(
    row("s", [0.5, 0.5], col("l", [0.5, 0.5], pane("a"), pane("c")), col("r", [0.5, 0.5], pane("b"), pane("d"))),
    1000,
    600,
  );

  it.each([
    { pane: "a", want: { left: null, down: "c", up: null, right: "b" } },
    { pane: "b", want: { left: "a", down: "d", up: null, right: null } },
    { pane: "c", want: { left: null, down: null, up: "a", right: "d" } },
    { pane: "d", want: { left: "c", down: null, up: "b", right: null } },
  ])("in a grid of four, from $pane", ({ pane: p, want }) => {
    expect(neighbours(grid, p)).toEqual(want);
  });

  it("an unknown pane has none", () => {
    for (const dir of DIRECTIONS) expect(neighbour(grid, "p-gone", dir)).toBeNull();
  });

  it("the one sharing more of the edge wins", () => {
    const frame = plainRects(row("s", [0.5, 0.5], pane("a"), col("c", [0.7, 0.3], pane("b"), pane("d"))), 1000, 600);
    expect(neighbour(frame, "a", "right")).toBe("b");
    const flipped = plainRects(row("s", [0.5, 0.5], pane("a"), col("c", [0.3, 0.7], pane("b"), pane("d"))), 1000, 600);
    expect(neighbour(flipped, "a", "right")).toBe("d");
  });

  it("of two sharing as much, the upper (for left and right) or the left (for up and down)", () => {
    const tall = plainRects(row("s", [0.5, 0.5], col("c", [0.5, 0.5], pane("b"), pane("d")), pane("a")), 1000, 600);
    expect(neighbour(tall, "a", "left")).toBe("b");
    const wide = plainRects(col("s", [0.5, 0.5], pane("a"), row("r", [0.5, 0.5], pane("b"), pane("d"))), 1000, 600);
    expect(neighbour(wide, "a", "down")).toBe("b");
    expect(neighbour(wide, "d", "up")).toBe("a");
  });

  it("the nearest wins over one further on that shares more", () => {
    // a | b | c with d under all three: from a, right is b, not c.
    const frame = plainRects(
      col("s", [0.5, 0.5], row("r", [0.2, 0.2, 0.6], pane("a"), pane("b"), pane("c")), pane("d")),
      1000,
      600,
    );
    expect(neighbours(frame, "a")).toEqual({ left: null, down: "d", up: null, right: "b" });
    expect(neighbours(frame, "d")).toEqual({ left: null, down: null, up: "c", right: null });
  });

  it("reaches rails and moves on past them, as drawn", () => {
    const root = row(
      "s",
      [0.25, 0.25, 0.25, 0.25],
      pane("a", "thread:A"),
      pane("b", "diff:A"),
      pane("c", "prs"),
      pane("d", "thread:B"),
    );
    const frame = shellFrame({ root, w: 900, h: 600, focus: "a", mru: ["a/0", "d/0", "b/0"] });
    expect(frame.rects.b?.rail && frame.rects.c?.rail).toBe(true);
    expect(neighbours(frame, "a")).toEqual({ left: null, down: null, up: null, right: "b" });
    expect(neighbours(frame, "b")).toEqual({ left: "a", down: null, up: null, right: "c" });
    expect(neighbours(frame, "c")).toEqual({ left: "b", down: null, up: null, right: "d" });
    expect(neighbours(frame, "d")).toEqual({ left: "c", down: null, up: null, right: null });
  });

  it("a horizontal rail is above or below its neighbours", () => {
    const root = col("s", [0.5, 0.25, 0.25], pane("a", "thread:A"), pane("b", "terminal"), pane("c", "diff"));
    const frame = shellFrame({ root, w: 800, h: 400, focus: "a", mru: ["a/0", "b/0", "c/0"] });
    expect(frame.rects.c?.rail).toBe(true);
    expect(neighbours(frame, "c")).toEqual({ left: null, down: null, up: "b", right: null });
    expect(neighbour(frame, "b", "down")).toBe("c");
  });
});
