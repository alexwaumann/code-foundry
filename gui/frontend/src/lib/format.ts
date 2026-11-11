/** When a message was sent: "14:02" for today's, else the date too ("Oct 3 14:02"); "" when not known (null). */
export function sentTime(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}`;
}
