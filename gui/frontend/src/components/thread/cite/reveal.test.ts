import { describe, expect, it } from "vitest";
import { visibleTop } from "./reveal";

const rect = (left: number, top: number, width: number, height: number) => DOMRect.fromRect({ x: left, y: top, width, height });

function at(el: Element, r: DOMRect): void {
  el.getBoundingClientRect = () => r;
}

/** A thread body with its list (top at 100) and, optionally, the find bar (x 600-908, y 112-150). */
function body(withBar: boolean): { pane: HTMLElement; scroller: HTMLElement } {
  const pane = document.createElement("div");
  const scroller = document.createElement("div");
  at(scroller, rect(0, 100, 1000, 800));
  pane.append(scroller);
  if (withBar) {
    const bar = document.createElement("div");
    bar.dataset.testid = "thread-find";
    at(bar, rect(600, 112, 308, 38));
    pane.append(bar);
  }
  return { pane, scroller };
}

describe("visibleTop", () => {
  it("is the list's top without the find bar", () => {
    const { pane, scroller } = body(false);
    expect(visibleTop(pane, scroller, [rect(40, 120, 700, 20)])).toBe(100);
  });

  it("is below the find bar for lines under it (the card closed: the bar lies over the text)", () => {
    const { pane, scroller } = body(true);
    expect(visibleTop(pane, scroller, [rect(40, 120, 700, 20)])).toBe(150);
  });

  it("is the list's top for lines beside the bar (an inline card: the bar is over the card's column)", () => {
    const { pane, scroller } = body(true);
    expect(visibleTop(pane, scroller, [rect(40, 120, 500, 20)])).toBe(100);
  });
});
