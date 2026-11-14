/**
 * The pane a direction key moves to (ctrl+cmd+h j k l), on the frame as drawn: rails are panes
 * like any other, so a key can reach a folded pane. The candidates are the panes that touch that
 * side across one gutter (they lie wholly on that side and share some of the edge). Of several,
 * the one focused most recently wins (the first to hold a tab of the space's `mru`), so going one
 * way and back returns to the pane the key left whenever that pane still touches; then the one
 * sharing the longest stretch of edge, then the one nearer the top (for left and right) or the
 * left (for up and down), then by id. The daemon's `Layout.Neighbour` (internal/layout
 * neighbour.go) is the same rule, for the CLI; `internal/layout/testdata/neighbour.json` holds
 * both to it. At the area's edge there is none. See docs/notes/shell-9-geometry.md and
 * docs/notes/shell-25b-audits.md.
 */
import type { Frame, GeoNode } from "./types";
import { panesOf } from "./types";

export type Direction = "left" | "down" | "up" | "right";

export const DIRECTIONS: readonly Direction[] = ["left", "down", "up", "right"];

/** How far a pane may reach past the edge and still count as on that side (rounding). */
const SLACK = 1;

/** What ranks the candidates beyond geometry: the tree (which pane holds which tab) and the space's mru. */
export interface Recency {
  root: GeoNode | null;
  /** Tab ids, most recently focused first. */
  mru: readonly string[];
}

interface Hit {
  id: string;
  gap: number;
  ov: number;
  at: number;
  /** The pane's place in the mru (its most recent tab's); Infinity when none of its tabs is in it. */
  rec: number;
}

/** Each pane's place in the mru: its most recently focused tab's index. */
function recencyOf(r: Recency | undefined): Map<string, number> {
  const out = new Map<string, number>();
  if (!r) return out;
  const at = new Map<string, number>();
  r.mru.forEach((id, i) => {
    if (!at.has(id)) at.set(id, i);
  });
  for (const p of panesOf(r.root)) {
    const best = Math.min(Infinity, ...(p.tabs ?? []).map((t) => at.get(t.id) ?? Infinity));
    if (best < Infinity) out.set(p.id, best);
  }
  return out;
}

/** The pane next to `pane` in that direction, or null. */
export function neighbour(frame: Frame, pane: string, dir: Direction, recency?: Recency): string | null {
  const c = frame.rects[pane];
  if (!c) return null;
  const across = dir === "left" || dir === "right";
  const rec = recencyOf(recency);
  const hits: Hit[] = [];
  for (const [id, r] of Object.entries(frame.rects)) {
    if (id === pane) continue;
    const gap = {
      right: r.x - (c.x + c.w),
      left: c.x - (r.x + r.w),
      down: r.y - (c.y + c.h),
      up: c.y - (r.y + r.h),
    }[dir];
    const ov = across ? Math.min(r.y + r.h, c.y + c.h) - Math.max(r.y, c.y) : Math.min(r.x + r.w, c.x + c.w) - Math.max(r.x, c.x);
    if (gap < -SLACK || ov <= 0) continue;
    hits.push({ id, gap, ov, at: across ? r.y : r.x, rec: rec.get(id) ?? Infinity });
  }
  if (hits.length === 0) return null;
  // The panes that touch that side: the nearest (in a tiling, across exactly one gutter).
  const nearest = Math.min(...hits.map((h) => h.gap));
  let best: Hit | null = null;
  for (const h of hits) {
    if (h.gap > nearest + SLACK) continue;
    if (!best || better(h, best)) best = h;
  }
  return best?.id ?? null;
}

function better(a: Hit, b: Hit): boolean {
  if (a.rec !== b.rec) return a.rec < b.rec;
  if (a.ov !== b.ov) return a.ov > b.ov;
  if (a.at !== b.at) return a.at < b.at;
  return a.id < b.id;
}

/** Every direction's neighbour of a pane. */
export function neighbours(frame: Frame, pane: string, recency?: Recency): Record<Direction, string | null> {
  return {
    left: neighbour(frame, pane, "left", recency),
    down: neighbour(frame, pane, "down", recency),
    up: neighbour(frame, pane, "up", recency),
    right: neighbour(frame, pane, "right", recency),
  };
}
