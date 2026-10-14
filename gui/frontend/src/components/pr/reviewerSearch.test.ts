import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { REVIEWER_SEARCH_DEBOUNCE_MS, reviewerSearchTerm, useReviewerSearchTerm } from "./reviewerSearch";

afterEach(() => {
  vi.useRealTimers();
});

describe("reviewerSearchTerm", () => {
  it.each([
    ["", ""],
    ["a", ""],
    ["  a  ", ""],
    ["ab", "ab"],
    ["  ab ", "ab"],
    ["Ana Lee", "Ana Lee"],
  ])("%j → %j", (input, want) => {
    expect(reviewerSearchTerm(input)).toBe(want);
  });
});

describe("useReviewerSearchTerm", () => {
  it("waits out the pause before a term, restarts it on typing, and clears under 2 characters at once", () => {
    vi.useFakeTimers();
    const { result, rerender } = renderHook(({ input }) => useReviewerSearchTerm(input), { initialProps: { input: "" } });
    expect(result.current).toEqual({ term: "", pending: false });

    rerender({ input: "a" }); // under the threshold: nothing to wait for
    expect(result.current).toEqual({ term: "", pending: false });

    rerender({ input: "an" });
    expect(result.current).toEqual({ term: "", pending: true });
    act(() => {
      vi.advanceTimersByTime(REVIEWER_SEARCH_DEBOUNCE_MS - 50);
    });
    rerender({ input: "ana" }); // typing restarts the pause
    act(() => {
      vi.advanceTimersByTime(REVIEWER_SEARCH_DEBOUNCE_MS - 50);
    });
    expect(result.current).toEqual({ term: "", pending: true });
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(result.current).toEqual({ term: "ana", pending: false });

    rerender({ input: "ana " }); // same trimmed term: no new search
    expect(result.current).toEqual({ term: "ana", pending: false });

    rerender({ input: "a" });
    expect(result.current).toEqual({ term: "", pending: false });
  });
});
