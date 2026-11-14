import { describe, expect, it } from "vitest";
import { threadDropArgs } from "./threadDrop";

describe("dropping a sidebar thread: one thread.open with the place", () => {
  it("on a pane's middle: in that pane", () => {
    expect(threadDropArgs("s-1", { kind: "pane", pane: "p-2" })).toEqual({ id: "s-1", focus: "true", pane: "p-2" });
  });

  it("in a strip: in that pane at the place the bar showed", () => {
    expect(threadDropArgs("s-1", { kind: "strip", pane: "p-2", index: 1 })).toEqual({ id: "s-1", focus: "true", pane: "p-2", index: "1" });
    expect(threadDropArgs("s-1", { kind: "strip", pane: "p-2", index: 0 })).toEqual({ id: "s-1", focus: "true", pane: "p-2", index: "0" });
  });

  it("on a pane's edge: a new pane on that edge of it", () => {
    expect(threadDropArgs("s-1", { kind: "edge", pane: "p-2", edge: "left" })).toEqual({ id: "s-1", focus: "true", split: "p-2", edge: "left" });
  });

  it("on the outer edge: a new pane on that edge of the grid", () => {
    expect(threadDropArgs("s-1", { kind: "outer", edge: "bottom" })).toEqual({ id: "s-1", focus: "true", outer: "bottom" });
  });
});
