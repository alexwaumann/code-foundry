import type { FindResults } from "./renderer";

export const NO_RESULTS: FindResults = { index: -1, total: 0, capped: false };

/** "4 of 9". At the highlight limit the total is a floor, and a current match past it has no number. */
export function terminalCountLabel({ index, total, capped }: FindResults): string {
  if (!capped) return `${String(index + 1)} of ${String(total)}`;
  return index < 0 ? `${String(total)}+` : `${String(index + 1)} of ${String(total)}+`;
}
