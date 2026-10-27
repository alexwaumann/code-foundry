import { useEffect, useState } from "react";

/** The reviewer picker searches GitHub from this many characters (trimmed) on. */
export const REVIEWER_SEARCH_MIN_CHARS = 2;
/** Typing pause before the picker searches. */
export const REVIEWER_SEARCH_DEBOUNCE_MS = 250;

/** A search asks GitHub for at most this many words on their own (the daemon's cap). */
export const REVIEWER_SEARCH_MAX_TOKENS = 4;

/**
 * The words of a search, as the daemon splits them (internal/store/gh/reviewer_search.go):
 * on whitespace and commas, empty pieces dropped, at most REVIEWER_SEARCH_MAX_TOKENS.
 */
export function reviewerSearchTokens(term: string): string[] {
  return term
    .split(/[\s,]+/u)
    .filter((t) => t !== "")
    .slice(0, REVIEWER_SEARCH_MAX_TOKENS);
}

/** Lowercased, letters and digits only: "Doe, Jane" and "jane-doe" compare by their letters. */
const fold = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * Whether a person matches a search: every word (folded; words with no letter or digit
 * are ignored) is in the login or the name. "jane doe" matches a name stored as "Doe, Jane".
 */
export function matchesReviewerSearch(login: string, name: string, term: string): boolean {
  const l = fold(login);
  const n = fold(name);
  return reviewerSearchTokens(term)
    .map(fold)
    .filter((t) => t !== "")
    .every((t) => l.includes(t) || n.includes(t));
}

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
