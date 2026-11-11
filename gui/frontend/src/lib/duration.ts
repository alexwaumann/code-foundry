/**
 * The app's one style for how long something took or has run (formatDuration), how long
 * ago something happened (formatAge) and a running clock (formatClock). The caller picks
 * which units may show.
 */

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

/** The units a duration may show. */
export interface DurationUnits {
  days?: boolean;
  hours?: boolean;
  minutes?: boolean;
  seconds?: boolean;
  /** With seconds: under 10 s in tenths of a second ("4.2s"), for a quick run that would read "0s". */
  tenths?: boolean;
}

const DURATION_UNITS = [
  ["days", DAY, "d"],
  ["hours", HOUR, "h"],
  ["minutes", MINUTE, "m"],
  ["seconds", SECOND, "s"],
] as const;

/**
 * A duration in the largest chosen unit it reaches, then the next chosen unit unless that
 * part is zero: "12s", "4m 8s", "4m", "1h 5m", "3d 2h". Rounded down and unpadded; a
 * negative or unknown one counts as zero, and one under the smallest chosen unit is zero
 * of it ("0s", "0m"). "" when no unit is chosen.
 */
export function formatDuration(ms: number, units: DurationUnits): string {
  const d = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (units.tenths && units.seconds && d < 10 * SECOND) return `${(Math.floor(d / 100) / 10).toFixed(1)}s`;
  const chosen = DURATION_UNITS.filter(([k]) => units[k]);
  const smallest = chosen.at(-1);
  if (!smallest) return "";
  const i = chosen.findIndex(([, size]) => d >= size);
  const unit = chosen[i];
  if (!unit) return `0${smallest[2]}`;
  const [, size, abbr] = unit;
  const first = `${String(Math.floor(d / size))}${abbr}`;
  const next = chosen[i + 1];
  const rest = next ? Math.floor((d % size) / next[1]) : 0;
  return next && rest > 0 ? `${first} ${String(rest)}${next[2]}` : first;
}

/** The units an age may show, and whether it ends in "ago" (default). */
export interface AgeUnits {
  years?: boolean;
  months?: boolean;
  weeks?: boolean;
  days?: boolean;
  hours?: boolean;
  minutes?: boolean;
  seconds?: boolean;
  /** false: "4m" and "now" in place of "4m ago" and "just now", for a table cell. */
  ago?: boolean;
}

/** Each unit's size, its letters, and how many of it it takes to replace the next smaller chosen unit. */
const AGE_UNITS = [
  ["years", YEAR, "y", 1],
  ["months", MONTH, "mo", 2],
  ["weeks", WEEK, "w", 2],
  ["days", DAY, "d", 1],
  ["hours", HOUR, "h", 1],
  ["minutes", MINUTE, "m", 1],
  ["seconds", SECOND, "s", 1],
] as const;

/**
 * How long ago `atMs` was, at `now`, in the largest chosen unit it reaches: "12s ago",
 * "4m ago", "3h ago", "2d ago", "3w ago", "4mo ago", "1y ago". Weeks and months take over
 * from two of them when a smaller unit is chosen ("13d ago", then "2w ago"; "8w ago",
 * then "2mo ago"). Rounded down; under the smallest chosen unit (a future time included)
 * it is "just now".
 */
export function formatAge(atMs: number, now: number, units: AgeUnits): string {
  const d = Math.max(0, now - atMs);
  const ago = units.ago ?? true;
  const chosen = AGE_UNITS.filter(([k]) => units[k]);
  for (const [i, [, size, abbr, from]] of chosen.entries()) {
    const n = Math.floor(d / size);
    if (n >= (i < chosen.length - 1 ? from : 1)) return ago ? `${String(n)}${abbr} ago` : `${String(n)}${abbr}`;
  }
  return ago ? "just now" : "now";
}

/** A running clock: "0:04", "12:05", "1:02:03" (a negative time counts as zero). */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / SECOND));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, "0");
  return h > 0 ? `${String(h)}:${String(m).padStart(2, "0")}:${s}` : `${String(m)}:${s}`;
}
