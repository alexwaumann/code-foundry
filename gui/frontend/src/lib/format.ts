/** Formats a duration in seconds as e.g. "3d 4h", "2h 5m", "4m 9s", "12s". */
export function formatUptime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${String(d)}d ${String(h)}h`;
  if (h > 0) return `${String(h)}h ${String(m)}m`;
  if (m > 0) return `${String(m)}m ${String(sec)}s`;
  return `${String(sec)}s`;
}

/** When a message was sent: "14:02" for today's, else the date too ("Oct 3 14:02"); "" when not known (null). */
export function sentTime(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
