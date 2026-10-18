/**
 * How the host formats a view's times (PRIMITIVES.md §A "time", DECISIONS.md "duration"):
 * one shared style for elapsed times and fixed durations, relative times, countdowns.
 */

/** "42s", "4m 12s", "1h 4m", "2d 3h" (negative counts as zero). */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${String(s)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m ${String(s % 60)}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h ${String(m % 60)}m`;
  return `${String(Math.floor(h / 24))}d ${String(h % 24)}h`;
}

/**
 * A `duration` span (a fixed time a plugin measured): tenths under 10 s, as the thread
 * view's tool rows do ("0.1s", "2.3s"), so a quick test run does not read "took 0s";
 * whole units from 10 s on (formatDuration). An elapsed time keeps whole seconds.
 */
export function formatFixedDuration(ms: number): string {
  if (ms <= 0) return "0s";
  if (ms < 100) return "<0.1s";
  if (ms < 10_000) return `${(Math.floor(ms / 100) / 10).toFixed(1)}s`;
  return formatDuration(ms);
}

function unit(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? "" : "s"}`;
}

/** "just now", "12s ago", "5m ago", "3h ago", "2 days ago"; "in 12s", "in 3 days" ahead. */
export function formatRelative(atMs: number, nowMs: number): string {
  const d = atMs - nowMs;
  const s = Math.floor(Math.abs(d) / 1000);
  if (s < 5) return "just now";
  const body = s < 60 ? `${String(s)}s` : s < 3600 ? `${String(Math.floor(s / 60))}m` : s < 86_400 ? `${String(Math.floor(s / 3600))}h` : unit(Math.floor(s / 86_400), "day");
  return d > 0 ? `in ${body}` : `${body} ago`;
}

/** "9:41", "1:02:03" until atMs, then "expired". */
export function formatCountdown(atMs: number, nowMs: number): string {
  const s = Math.floor((atMs - nowMs) / 1000);
  if (s <= 0) return "expired";
  const h = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${String(h)}:${String(mm).padStart(2, "0")}:${ss}` : `${String(mm)}:${ss}`;
}

/** A time span's text now; "" for a time that does not parse. */
export function formatTime(at: string, style: "relative" | "elapsed" | "countdown" | undefined, nowMs: number): string {
  const ms = Date.parse(at);
  if (Number.isNaN(ms)) return "";
  if (style === "elapsed") return formatDuration(nowMs - ms);
  if (style === "countdown") return formatCountdown(ms, nowMs);
  return formatRelative(ms, nowMs);
}
