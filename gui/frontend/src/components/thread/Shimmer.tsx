import { useState, type ReactNode } from "react";
import { SHIMMER_PERIOD_MS, shimmerPhase, type ShimmerKind } from "@/lib/shimmer";

/**
 * A live line's text with a soft light band crossing it (thread.css `.shimmer`;
 * docs/notes/running-rows.md): a live header's first part ("Working") and a running row's
 * label. One mechanism for both: a gradient from the muted tone to the text tone and back,
 * clipped to the glyphs, its background-position moving. Nothing lays out.
 *
 * Every shimmer keeps the page clock's phase (a negative animation-delay taken when it mounts,
 * as StatusCircle does), so one that mounts again (a virtualized row scrolled back, the live
 * header settling) carries on where it was. A row's band also starts `offsetMs` later than
 * the page clock's: rows pass their position in the log times ROW_STAGGER_MS (lib/shimmer), so a column of
 * tools running in parallel reads as one wave going down, not N flickers.
 *
 * It plays under prefers-reduced-motion too: it says something is running, it is not a
 * transition (docs/notes/working-circle.md).
 */

export function Shimmer({ kind = "head", offsetMs = 0, children }: { kind?: ShimmerKind; offsetMs?: number; children: ReactNode }) {
  const [mountedAt] = useState(() => performance.now());
  return (
    <span className="shimmer" data-shimmer={kind} style={{ animationDuration: `${String(SHIMMER_PERIOD_MS[kind])}ms`, animationDelay: shimmerPhase(kind, mountedAt, offsetMs) }}>
      {children}
    </span>
  );
}
