import { describe, expect, it } from "vitest";
import { scrollIntent } from "./scrollIntent";

describe("scrollIntent", () => {
  const at = (top: number, height = 5000) => ({ top, height });
  it.each([
    { name: "a wheel in the list", input: true, overFrame: false, prev: at(4000), now: at(3700), want: "user" },
    { name: "the user's input, the list growing", input: true, overFrame: false, prev: at(4000), now: at(4200, 5400), want: "user" },
    { name: "a wheel chained from a frame, up", input: false, overFrame: true, prev: at(4000), now: at(3700), want: "user" },
    { name: "chained from a frame while text streams in", input: false, overFrame: true, prev: at(4000), now: at(3900, 5100), want: "user" },
    { name: "over a frame, the list clamped by a shrinking card", input: false, overFrame: true, prev: at(4000), now: at(3800, 4800), want: "layout" },
    { name: "over a frame, down", input: false, overFrame: true, prev: at(3700), now: at(4000), want: "layout" },
    { name: "over a frame, no move", input: false, overFrame: true, prev: at(4000), now: at(4000), want: "layout" },
    { name: "no input, not over a frame, up", input: false, overFrame: false, prev: at(4000), now: at(3700), want: "layout" },
    { name: "the virtualizer measuring a row above smaller", input: false, overFrame: false, prev: at(4000), now: at(3960, 4960), want: "layout" },
  ] as const)("$name", ({ input, overFrame, prev, now, want }) => {
    expect(scrollIntent({ input, overFrame, prev, now })).toBe(want);
  });
});
