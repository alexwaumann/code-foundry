import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesReviewerSearch, REVIEWER_SEARCH_DEBOUNCE_MS, reviewerSearchTerm, reviewerSearchTokens, useReviewerSearchTerm } from "./reviewerSearch";

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

describe("reviewerSearchTokens", () => {
  it.each([
    ["", []],
    ["jane", ["jane"]],
    ["jane doe", ["jane", "doe"]],
    ["doe, jane", ["doe", "jane"]],
    ["Doe,Jane", ["Doe", "Jane"]],
    [" ,, jane\tdoe ,", ["jane", "doe"]],
    ["a b c d e f", ["a", "b", "c", "d"]],
    ["jane-doe", ["jane-doe"]],
  ])("%j → %j", (term, want) => {
    expect(reviewerSearchTokens(term)).toEqual(want);
  });
});

describe("matchesReviewerSearch", () => {
  it.each([
    ["first last against a stored last, first", "jdoe", "Doe, Jane", "jane doe", true],
    ["last, first", "jdoe", "Doe, Jane", "doe, jane", true],
    ["case and punctuation do not matter", "jdoe", "DOE, JANE", "Jane, Doe.", true],
    ["one word, as before", "teammate-lee", "Lee", "lee", true],
    ["a login-only hit", "kim-lee", "", "kim lee", true],
    ["words split between login and name", "jdoe", "Jane", "jane jdoe", true],
    ["inside words", "xjanex", "Mary Doeville", "jane doe", true],
    ["a missing word", "janet", "Janet Smith", "jane doe", false],
    ["a missing word in either field", "doe-j", "John Doe", "jane doe", false],
    ["punctuation-only words are ignored", "jdoe", "Doe, Jane", "jane - doe", true],
  ])("%s", (_name, login, name, term, want) => {
    expect(matchesReviewerSearch(login, name, term)).toBe(want);
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

    rerender({ input: "bo" }); // a new search starts empty, not with the last results
    expect(result.current).toEqual({ term: "", pending: true });
  });
});
