/**
 * The sidebar inbox row's elapsed times (docs/notes/sidebar-inbox-2-libs.md): how long a
 * thread has been working or waiting, or since an idle one last did something. Rounded
 * down; a time in the future reads "0s".
 */

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "4s" under a minute, "4m" under an hour, "1h 4m" ("1h" on the hour) under a day, "3d" from a day. */
export function formatElapsed(ms: number, now: number): string {
  const d = Math.max(0, now - ms);
  if (d < MINUTE) return `${String(Math.floor(d / SECOND))}s`;
  if (d < HOUR) return `${String(Math.floor(d / MINUTE))}m`;
  if (d < DAY) {
    const h = Math.floor(d / HOUR);
    const m = Math.floor((d % HOUR) / MINUTE);
    return m === 0 ? `${String(h)}h` : `${String(h)}h ${String(m)}m`;
  }
  return `${String(Math.floor(d / DAY))}d`;
}

/**
 * How often a row showing formatElapsed(ms, now) re-renders: every second while it shows
 * seconds (under a minute, a future time included), else once a minute.
 */
export function elapsedTickMs(ms: number, now: number): number {
  return now - ms < MINUTE ? SECOND : MINUTE;
}
