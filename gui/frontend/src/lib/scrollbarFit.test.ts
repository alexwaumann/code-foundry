import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Fit = typeof import("./scrollbarFit").fitScrollbar;

let fire: (el: HTMLElement) => void;
let unobserved: Element[];
let fitScrollbar: Fit;

beforeEach(async () => {
  unobserved = [];
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(cb: ResizeObserverCallback) {
        fire = (el) => {
          cb([{ target: el } as unknown as ResizeObserverEntry], this);
        };
      }
      observe() {}
      unobserve(el: Element) {
        unobserved.push(el);
      }
      disconnect() {}
    },
  );
  // The observer is the module's own: a fresh module takes this test's stub.
  vi.resetModules();
  ({ fitScrollbar } = await import("./scrollbarFit"));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** A box whose heights the test sets, with a 1px border top and bottom. */
function box(): HTMLElement & { heights(offset: number, client: number): void } {
  const el = document.createElement("pre");
  el.style.borderBottomWidth = "1px";
  el.style.borderBottomStyle = "solid";
  Object.defineProperty(el, "clientTop", { value: 1 });
  return Object.assign(el, {
    heights(offset: number, client: number) {
      Object.defineProperty(el, "offsetHeight", { value: offset, configurable: true });
      Object.defineProperty(el, "clientHeight", { value: client, configurable: true });
    },
  });
}

describe("fitScrollbar", () => {
  it.each([
    ["no bar: nothing to settle", [[52, 50]], ""],
    ["rounding of a fractional height is no bar", [[53, 50]], ""],
    ["a bar on the first measure dirties the box", [[69, 50]], "1px"],
    ["a bar appearing later dirties the box", [[52, 50], [69, 50]], "1px"],
    ["growing with the bar kept changes nothing more", [[69, 50], [88, 69]], "1px"],
    ["growing without a bar changes nothing", [[52, 50], [71, 69]], ""],
    ["the bar going dirties the box again", [[69, 50], [52, 50]], ""],
  ] as const)("%s", (_name, steps, minHeight) => {
    const el = box();
    fitScrollbar(el);
    for (const [offset, client] of steps) {
      el.heights(offset, client);
      fire(el);
    }
    expect(el.style.minHeight).toBe(minHeight);
  });

  it("counts each change of the bar once", () => {
    const el = box();
    const set = vi.spyOn(el.style, "minHeight", "set");
    fitScrollbar(el);
    for (const [offset, client] of [[52, 50], [69, 50], [69, 50], [88, 69], [52, 50]] as const) {
      el.heights(offset, client);
      fire(el);
    }
    expect(set).toHaveBeenCalledTimes(2);
  });

  it("a box with no bottom border still reads its bar", () => {
    const el = box();
    el.style.borderBottomWidth = "0px";
    fitScrollbar(el);
    el.heights(35, 34);
    fire(el);
    expect(el.style.minHeight).toBe("");
    el.heights(52, 34);
    fire(el);
    expect(el.style.minHeight).toBe("1px");
  });

  it("stops watching when the box goes", () => {
    const el = box();
    const stop = fitScrollbar(el);
    stop?.();
    expect(unobserved).toEqual([el]);
  });
});
