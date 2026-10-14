/**
 * Snoozed threads in the GUI (docs/notes/snooze-threads-2-sidebar.md): the snooze menu's
 * presets, the custom date dialog's calendar, and how a wake time reads. Pure, over local
 * time with `now` injected; the GUI sends absolute times (snoozeSession), so the presets
 * mean what the user saw in the menu, whatever the daemon's clock. Day presets are local
 * wall times (9:00 AM stays 9:00 AM across DST), like the daemon's `tomorrow` and
 * `next-week` (internal/command/snooze_time.go).
 */

/** The hour day presets (Tomorrow, Next week) and the custom dialog default to. */
export const SNOOZE_HOUR = 9;

const HOUR = 3_600_000;
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"] as const;

/** A local calendar day; `month` is 0-based like Date's. */
export interface Day {
  year: number;
  month: number;
  day: number;
}

export function dayOf(ms: number): Day {
  const d = new Date(ms);
  return { year: d.getFullYear(), month: d.getMonth(), day: d.getDate() };
}

/** The day `n` days after `d` on the calendar (not n × 24 h: DST days are 23 or 25 h). */
export function addDays(d: Day, n: number): Day {
  return dayOf(new Date(d.year, d.month, d.day + n, 12).getTime());
}

export function sameDay(a: Day, b: Day): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day;
}

/** Orders days: negative when a is before b. */
export function compareDays(a: Day, b: Day): number {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * Local wall time on a day, epoch ms. A time inside a spring-forward gap moves forward by
 * the gap (2:30 AM on the DST day is 3:30 AM), as the daemon's parser does.
 */
export function wallTime(d: Day, hour: number, minute = 0): number {
  return new Date(d.year, d.month, d.day, hour, minute).getTime();
}

export type SnoozePresetId = "1h" | "3h" | "tomorrow" | "next-week";

export interface SnoozePreset {
  id: SnoozePresetId;
  label: string;
  untilMs: number;
  /** The resolved time on the menu's right ("2:12 PM", "Thu 9:00 AM"). */
  hint: string;
}

/**
 * The snooze menu's presets at `now`: 1 hour and 3 hours from now; tomorrow at 9:00 AM;
 * next week, 9:00 AM next Monday (on a Monday, the following one).
 */
export function snoozePresets(now: number): SnoozePreset[] {
  const today = dayOf(now);
  const weekday = new Date(now).getDay();
  // Days to the next Monday: 1 on Sunday, 7 on Monday, 6 on Tuesday, …
  const toMonday = ((8 - weekday) % 7) || 7;
  const at = (id: SnoozePresetId, label: string, untilMs: number): SnoozePreset => ({ id, label, untilMs, hint: snoozeTimeShort(untilMs, now) });
  return [
    at("1h", "1 hour", now + HOUR),
    at("3h", "3 hours", now + 3 * HOUR),
    at("tomorrow", "Tomorrow", wallTime(addDays(today, 1), SNOOZE_HOUR)),
    at("next-week", "Next week", wallTime(addDays(today, toMonday), SNOOZE_HOUR)),
  ];
}

/** "2:12 PM", "9:00 AM", "12:05 AM". */
export function formatClock(ms: number): string {
  const d = new Date(ms);
  const h = d.getHours();
  return `${String(h % 12 || 12)}:${String(d.getMinutes()).padStart(2, "0")} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * A wake time as short as it can be told apart: "2:12 PM" today, "Thu 9:00 AM" within the
 * next six days (a week ahead would repeat today's weekday), else "Oct 19, 9:00 AM" (and
 * the year when it is not this year: "Jan 7, 2027, 9:00 AM"). For the menu's hints and
 * "Snoozed until …" on the thread page.
 */
export function snoozeTimeShort(ms: number, now: number): string {
  const day = dayOf(ms);
  const today = dayOf(now);
  if (sameDay(day, today)) return formatClock(ms);
  if (compareDays(day, today) > 0 && compareDays(day, addDays(today, 6)) <= 0) return `${DAYS[new Date(ms).getDay()] ?? ""} ${formatClock(ms)}`;
  const year = day.year === today.year ? "" : `, ${String(day.year)}`;
  return `${MONTHS[day.month] ?? ""} ${String(day.day)}${year}, ${formatClock(ms)}`;
}

/** "Thu, Oct 15, 9:00 AM"; "Thu, Jan 7, 2027, 9:00 AM" in another year. The row tooltip's. */
export function snoozeTimeFull(ms: number, now: number): string {
  const d = new Date(ms);
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : `, ${String(d.getFullYear())}`;
  return `${DAYS[d.getDay()] ?? ""}, ${MONTHS[d.getMonth()] ?? ""} ${String(d.getDate())}${year}, ${formatClock(ms)}`;
}

/** "Fri, Oct 16" (and the year when it is not this year): the custom dialog's summary. */
export function formatDay(d: Day, now: number): string {
  const wd = DAYS[new Date(d.year, d.month, d.day, 12).getDay()] ?? "";
  const year = d.year === new Date(now).getFullYear() ? "" : `, ${String(d.year)}`;
  return `${wd}, ${MONTHS[d.month] ?? ""} ${String(d.day)}${year}`;
}

/** "October 2026". */
export function monthTitle(year: number, month: number): string {
  return `${MONTHS_LONG[month] ?? ""} ${String(year)}`;
}

/**
 * Time left until a wake, short and rounded down: "45m", "2h", "18h", "4d"; "<1m" under a
 * minute (and once it is due, until the daemon's next check wakes it).
 */
export function shortRemaining(untilMs: number, now: number): string {
  const m = Math.floor((untilMs - now) / 60_000);
  if (m < 1) return "<1m";
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h`;
  return `${String(Math.floor(h / 24))}d`;
}

/**
 * The calendar's weeks for a month, Sunday first: whole weeks from the one holding the 1st
 * to the one holding the last day, so leading and trailing days of the neighbouring months
 * fill the first and last weeks (4 to 6 weeks).
 */
export function monthGrid(year: number, month: number): Day[][] {
  const first = { year, month, day: 1 };
  const lead = new Date(year, month, 1, 12).getDay();
  const days = new Date(year, month + 1, 0, 12).getDate();
  const weeks = Math.ceil((lead + days) / 7);
  const start = addDays(first, -lead);
  return Array.from({ length: weeks }, (_, w) => Array.from({ length: 7 }, (_, i) => addDays(start, w * 7 + i)));
}

/** The month after (+1) or before (-1) one. */
export function shiftMonth(year: number, month: number, by: 1 | -1): { year: number; month: number } {
  const m = month + by;
  return m < 0 ? { year: year - 1, month: 11 } : m > 11 ? { year: year + 1, month: 0 } : { year, month: m };
}

/** "09:00" / "14:30" (an <input type="time"> value) as hour and minute; null when not a time. */
export function parseTimeValue(v: string): { hour: number; minute: number } | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(v.trim());
  if (!m) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  return hour < 24 && minute < 60 ? { hour, minute } : null;
}
