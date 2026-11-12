/**
 * The pane a direction key moves to (ctrl+cmd+h j k l), on the frame as drawn: rails are panes
 * like any other, so a key can reach a folded pane. The neighbour lies wholly on that side and
 * shares some of the edge; the nearest wins, then the one sharing the longest stretch of edge,
 * then the one nearer the top (for left and right) or the left (for up and down), then by id.
 * At the area's edge there is none. See docs/notes/shell-9-geometry.md.
 */
import type { Frame } from "./types";

export type Direction = "left" | "down" | "up" | "right";

export const DIRECTIONS: readonly Direction[] = ["left", "down", "up", "right"];

/** How far a pane may reach past the edge and still count as on that side (rounding). */
const SLACK = 1;

/** The pane next to `pane` in that direction, or null. */
export function neighbour(frame: Frame, pane: string, dir: Direction): string | null {
  const c = frame.rects[pane];
  if (!c) return null;
  const across = dir === "left" || dir === "right";
  let best: { id: string; gap: number; ov: number; at: number } | null = null;
  for (const [id, r] of Object.entries(frame.rects)) {
    if (id === pane) continue;
    const gap = {
      right: r.x - (c.x + c.w),
      left: c.x - (r.x + r.w),
      down: r.y - (c.y + c.h),
      up: c.y - (r.y + r.h),
    }[dir];
    const ov = across
      ? Math.min(r.y + r.h, c.y + c.h) - Math.max(r.y, c.y)
      : Math.min(r.x + r.w, c.x + c.w) - Math.max(r.x, c.x);
    if (gap < -SLACK || ov <= 0) continue;
    const at = across ? r.y : r.x;
    const hit = { id, gap, ov, at };
    if (!best || better(hit, best)) best = hit;
  }
  return best?.id ?? null;
}

function better(a: { id: string; gap: number; ov: number; at: number }, b: typeof a): boolean {
  if (a.gap !== b.gap) return a.gap < b.gap;
  if (a.ov !== b.ov) return a.ov > b.ov;
  if (a.at !== b.at) return a.at < b.at;
  return a.id < b.id;
}

/** Every direction's neighbour of a pane. */
export function neighbours(frame: Frame, pane: string): Record<Direction, string | null> {
  return {
    left: neighbour(frame, pane, "left"),
    down: neighbour(frame, pane, "down"),
    up: neighbour(frame, pane, "up"),
    right: neighbour(frame, pane, "right"),
  };
}
