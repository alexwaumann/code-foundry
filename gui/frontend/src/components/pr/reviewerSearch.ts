import { useEffect, useState } from "react";

/** The reviewer picker searches GitHub from this many characters (trimmed) on. */
export const REVIEWER_SEARCH_MIN_CHARS = 2;
/** Typing pause before the picker searches. */
export const REVIEWER_SEARCH_DEBOUNCE_MS = 250;

/** The term the picker would search for input: trimmed, or "" below the threshold. */
export function reviewerSearchTerm(input: string): string {
  const t = input.trim();
  return t.length >= REVIEWER_SEARCH_MIN_CHARS ? t : "";
}

/**
 * The debounced search term for the picker's input. `term` follows reviewerSearchTerm
 * after REVIEWER_SEARCH_DEBOUNCE_MS without typing; dropping under the threshold clears
 * it at once. `pending` is set while a new term waits out the pause.
 */
export function useReviewerSearchTerm(input: string): { term: string; pending: boolean } {
  const next = reviewerSearchTerm(input);
  const [term, setTerm] = useState(next);
  useEffect(() => {
    if (next === "") return;
    const t = setTimeout(() => {
      setTerm(next);
    }, REVIEWER_SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(t);
    };
  }, [next]);
  // Below the threshold the term clears at once, so a new search never shows the last
  // one's results during the pause.
  if (next === "" && term !== "") setTerm("");
  return next === "" ? { term: "", pending: false } : { term, pending: term !== next };
}
