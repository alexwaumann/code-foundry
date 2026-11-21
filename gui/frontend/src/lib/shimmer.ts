/**
 * The live shimmer's timing (components/thread/Shimmer.tsx, docs/notes/running-rows.md):
 * its sweep per kind, the stagger down a parallel batch, and the page-clock phase.
 */

export type ShimmerKind = "head" | "row";

/** One sweep, in ms. A row's is slower than the header's: nobody is meant to watch it. */
export const SHIMMER_PERIOD_MS: Readonly<Record<ShimmerKind, number>> = { head: 2000, row: 2400 };

/** How much later each row down a parallel batch starts its band. */
export const ROW_STAGGER_MS = 140;

/** The delay that puts a shimmer mounting at `nowMs` (page time) in phase with the page clock, `offsetMs` behind it. */
export function shimmerPhase(kind: ShimmerKind, nowMs: number, offsetMs = 0): string {
  const p = SHIMMER_PERIOD_MS[kind];
  return `-${String(Math.floor((((nowMs - offsetMs) % p) + p) % p))}ms`;
}
