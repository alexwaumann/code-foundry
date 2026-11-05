// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const move = (clientX: number, clientY: number) => {
  window.dispatchEvent(new MouseEvent("pointermove", { clientX, clientY }));
};

describe("pointerMoved", () => {
  let pointerMoved: () => boolean;
  beforeEach(async () => {
    vi.resetModules();
    ({ pointerMoved } = await import("./pointerMotion"));
  });

  it.each([
    { name: "the first event counts: nothing says the pointer was there", events: [[10, 20]], moved: true },
    { name: "the same position again is the pointer at rest", events: [[10, 20], [10, 20]], moved: false },
    { name: "x changed", events: [[10, 20], [11, 20]], moved: true },
    { name: "y changed", events: [[10, 20], [10, 21]], moved: true },
    { name: "at rest after moving", events: [[10, 20], [30, 40], [30, 40]], moved: false },
    { name: "back where it was two events ago", events: [[10, 20], [30, 40], [10, 20]], moved: true },
  ])("$name", ({ events, moved }) => {
    for (const [x = 0, y = 0] of events) move(x, y);
    expect(pointerMoved()).toBe(moved);
  });
});
