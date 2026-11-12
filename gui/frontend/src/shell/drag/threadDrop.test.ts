import { describe, expect, it } from "vitest";
import { threadDropPlan } from "./threadDrop";

describe("dropping a sidebar thread", () => {
  it("on a pane's middle: opens it in that pane, nothing after", () => {
    const p = threadDropPlan("s-1", { kind: "pane", pane: "p-2" });
    expect(p.open).toEqual({ id: "s-1", focus: "true", pane: "p-2" });
    expect(p.then).toBeNull();
  });

  it("in a strip: opens it in that pane, then moves its tab to the place the bar showed", () => {
    const p = threadDropPlan("s-1", { kind: "strip", pane: "p-2", index: 1 });
    expect(p.open).toEqual({ id: "s-1", focus: "true", pane: "p-2" });
    // It opened at 3 (after the active tab): the place before it counts the same.
    expect(p.then?.("t-new", 3)).toEqual({ name: "tab.move", args: { tab: "t-new", pane: "p-2", index: "1" } });
    // It opened at 0: places after it count it in.
    expect(p.then?.("t-new", 0)).toEqual({ name: "tab.move", args: { tab: "t-new", pane: "p-2", index: "2" } });
  });

  it("on a pane's edge: opens it there, then splits it off to that edge", () => {
    const p = threadDropPlan("s-1", { kind: "edge", pane: "p-2", edge: "left" });
    expect(p.open.pane).toBe("p-2");
    expect(p.then?.("t-new", 1)).toEqual({ name: "tab.move", args: { tab: "t-new", split: "p-2", edge: "left" } });
  });

  it("on the outer edge: opens it in the focused pane, then moves it to that edge of the grid", () => {
    const p = threadDropPlan("s-1", { kind: "outer", edge: "bottom" });
    expect(p.open).toEqual({ id: "s-1", focus: "true" });
    expect(p.then?.("t-new", 2)).toEqual({ name: "tab.move", args: { tab: "t-new", outer: "bottom" } });
  });
});
