/**
 * Auto-tidy's words (docs/notes/auto-tidy.md): a thread the daemon saved for later on its own
 * after a time without activity (ThreadView.autoSavedAfterMs, the setting's time then).
 */

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const UNITS: readonly { ms: number; one: string; many: string }[] = [
  { ms: 30 * DAY, one: "month", many: "months" },
  { ms: 7 * DAY, one: "week", many: "weeks" },
  { ms: DAY, one: "day", many: "days" },
  { ms: HOUR, one: "hour", many: "hours" },
];

/** A setting's span in words: whole months (30 days), weeks, days or hours ("3 days", "1 week"), else minutes. */
export function spanWords(ms: number): string {
  for (const u of UNITS) {
    if (ms >= u.ms && ms % u.ms === 0) {
      const n = ms / u.ms;
      return `${String(n)} ${n === 1 ? u.one : u.many}`;
    }
  }
  const min = Math.max(1, Math.round(ms / 60_000));
  return `${String(min)} ${min === 1 ? "minute" : "minutes"}`;
}

/** The hover card's line for an automatically saved thread: "Saved automatically after 3 days without activity"; null for any other. */
export function autoSavedSentence(afterMs: number | null | undefined): string | null {
  if (afterMs === null || afterMs === undefined || afterMs <= 0) return null;
  return `Saved automatically after ${spanWords(afterMs)} without activity`;
}
