// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useNow } from "./clock";

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
