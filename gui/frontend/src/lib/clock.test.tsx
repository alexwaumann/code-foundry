// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNow, useNowSelect } from "./clock";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("useNow", () => {
  it("a lone subscriber of a period renders a bounded number of times and ticks", () => {
    vi.useFakeTimers();
    // Time moves on between renders (it does in a browser), so a restarted clock reads a
    // new `now` every time.
    let t = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => (t += 7));
    let renders = 0;
    function Lone() {
      renders++;
      return <span data-testid="now">{useNow(30_000)}</span>;
    }
    // Before the fix, the inline subscribe restarted the clock on every render and this
    // threw "Maximum update depth exceeded".
    const { getByTestId, unmount } = render(<Lone />);
    expect(renders).toBeLessThan(5);
    const first = Number(getByTestId("now").textContent);
    act(() => {
      vi.advanceTimersByTime(30_000);
    });
    expect(renders).toBeLessThan(8);
    expect(Number(getByTestId("now").textContent)).toBeGreaterThan(first);
    unmount();
  });
});

describe("useNowSelect", () => {
  it("re-renders only when the selected value changes, and flips without interaction", () => {
    vi.useFakeTimers();
    const start = Date.now();
    let renders = 0;
    function Flip() {
      renders++;
      return <span data-testid="past">{String(useNowSelect(5000, (now) => now - start >= 20_000))}</span>;
    }
    const { getByTestId, unmount } = render(<Flip />);
    const before = renders;
    expect(getByTestId("past").textContent).toBe("false");
    act(() => {
      vi.advanceTimersByTime(15_000);
    });
    // Three ticks, the same answer: no render.
    expect(renders).toBe(before);
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(getByTestId("past").textContent).toBe("true");
    expect(renders).toBe(before + 1);
    unmount();
  });
});
