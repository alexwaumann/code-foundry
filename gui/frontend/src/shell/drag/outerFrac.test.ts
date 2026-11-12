import { describe, expect, it } from "vitest";
import kindsJson from "../../../../../internal/layout/testdata/kinds.json?raw";
import { KIND_SIZES, kindSize, outerFrac } from "./outerFrac";

const pane = { t: "pane" };
const row = { t: "split", dir: "row", kids: [pane, pane] };

describe("outerFrac", () => {
  it("knows each kind's size as internal/layout's identity table states it", () => {
    const kinds = JSON.parse(kindsJson) as { kind: string; default_frac: number; floor_px?: number }[];
    const want = Object.fromEntries(kinds.map((k) => [k.kind, { frac: k.default_frac, ...(k.floor_px ? { floor: k.floor_px } : {}) }]));
    expect(KIND_SIZES).toEqual(want);
  });

  it("finds a plugin surface's kind by its prefix, and nothing for an unknown one", () => {
    expect(kindSize("plugin.hello.demo")).toBe(KIND_SIZES["plugin."]);
    expect(kindSize("plugin.")).toBeUndefined();
    expect(kindSize("plugin.hello")).toBeUndefined();
    expect(kindSize("someday")).toBeUndefined();
  });

  // The same table as Go's TestOuterFrac (internal/layout/outer_test.go).
  it.each<[string, typeof row | typeof pane, string | undefined, "left" | "right" | "top" | "bottom", number | undefined, number, number, number]>([
    ["a given share wins", pane, "diff", "right", 0.2, 1000, 800, 0.2],
    ["no area: the kind's share", pane, "terminal", "right", undefined, 0, 0, 0.3],
    ["no area: no floor", pane, "diff", "right", undefined, 0, 0, 0.45],
    ["an unknown kind: half", pane, "someday", "right", undefined, 1000, 800, 0.5],
    ["a pane with no active tab: half", pane, undefined, "right", undefined, 1000, 800, 0.5],
    ["above the floor: the share", pane, "diff", "right", undefined, 1412, 800, 0.45],
    ["raised to the floor", pane, "diff", "right", undefined, 1012, 800, 0.48],
    ["no floor when the rest keeps too little", pane, "diff", "right", undefined, 912, 800, 0.45],
    ["top and bottom measure the height", pane, "diff", "bottom", undefined, 400, 1012, 0.48],
    ["joining a row counts its gutters", row, "diff", "left", undefined, 1024, 400, 0.48],
    ["a column beside a row has one gutter", row, "diff", "top", undefined, 400, 1012, 0.48],
    ["a negative area: the kind's share", pane, "diff", "right", undefined, -5, -5, 0.45],
  ])("%s", (_name, root, kind, edge, frac, w, h, want) => {
    expect(outerFrac(root, kind, edge, frac, w, h)).toBeCloseTo(want, 9);
  });
});
