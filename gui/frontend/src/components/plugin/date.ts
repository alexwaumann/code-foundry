/**
 * A date field's days (pluginsdk/ui InputDate): ISO dates ("2026-11-14", "" for none),
 * the month grid its calendar draws, the quick picks and the bounds. Days are counted in
 * UTC so a daylight-saving change never moves one; "today" is the user's local day.
 */

/** A day as numbers: month 1-12. */
export interface Ymd {
  y: number;
  m: number;
  d: number;
}

const ISO = /^(\d{4})-(\d{2})-(\d{2})$/;

/** An ISO date's numbers, or null when it is not a real day written YYYY-MM-DD. */
export function parseIso(s: string): Ymd | null {
  const m = ISO.exec(s);
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const t = new Date(Date.UTC(y, mo - 1, d));
  // Date.UTC maps 0-99 to 1900-1999: set the year itself.
  t.setUTCFullYear(y);
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  return { y, m: mo, d };
}

export function isIsoDate(s: string): boolean {
  return parseIso(s) !== null;
}

const pad = (n: number, w: number) => String(n).padStart(w, "0");

export function toIso({ y, m, d }: Ymd): string {
  return `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}`;
}

/** The UTC midnight of a day (for arithmetic and formatting without a time zone). */
function utc({ y, m, d }: Ymd): Date {
  const t = new Date(Date.UTC(2000, m - 1, d));
  t.setUTCFullYear(y);
  return t;
}

function ymdOf(t: Date): Ymd {
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

/** The ISO date n days after iso (n may be negative); iso must be a real day. */
export function addDays(iso: string, n: number): string {
  const p = parseIso(iso);
  if (!p) return iso;
  const t = utc(p);
  t.setUTCDate(t.getUTCDate() + n);
  return toIso(ymdOf(t));
}

/** The same day n months on, clamped to the month's last day (Jan 31 + 1 → Feb 28). */
export function addMonths(iso: string, n: number): string {
  const p = parseIso(iso);
  if (!p) return iso;
  const index = p.y * 12 + (p.m - 1) + n;
  const y = Math.floor(index / 12);
  const m = (index % 12) + 1;
  return toIso({ y, m, d: Math.min(p.d, daysIn(y, m)) });
}

export function daysIn(y: number, m: number): number {
  const t = utc({ y, m, d: 1 });
  t.setUTCMonth(t.getUTCMonth() + 1, 0);
  return t.getUTCDate();
}

/** The day of the week, 0 Sunday … 6 Saturday. */
export function weekday(iso: string): number {
  const p = parseIso(iso);
  return p ? utc(p).getUTCDay() : 0;
}

/** The user's local day now. */
export function todayIso(now: Date = new Date()): string {
  return toIso({ y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() });
}

/** The quick picks from today: today, tomorrow and the next Monday after today (a week on when today is a Monday). */
export function quickPicks(today: string): { today: string; tomorrow: string; nextMonday: string } {
  const ahead = ((1 - weekday(today) + 7) % 7) || 7;
  return { today, tomorrow: addDays(today, 1), nextMonday: addDays(today, ahead) };
}

/** Whether iso is between min and max ("" is no bound); ISO dates compare as strings. */
export function inRange(iso: string, min?: string, max?: string): boolean {
  return !(min && iso < min) && !(max && iso > max);
}

/** iso moved inside min..max. */
export function clampDate(iso: string, min?: string, max?: string): string {
  if (min && iso < min) return min;
  if (max && iso > max) return max;
  return iso;
}

/**
 * The locale's first day of the week, 0 Sunday … 6 Saturday (Intl.Locale's week info:
 * getWeekInfo, or the weekInfo accessor older engines have); Monday when the engine
 * cannot say.
 */
export function weekStartOf(locale?: string): number {
  try {
    const loc = new Intl.Locale(locale ?? new Intl.DateTimeFormat().resolvedOptions().locale) as Intl.Locale & {
      getWeekInfo?: () => { firstDay: number };
      weekInfo?: { firstDay: number };
    };
    const first = loc.getWeekInfo?.().firstDay ?? loc.weekInfo?.firstDay;
    if (first !== undefined && first >= 1 && first <= 7) return first % 7;
  } catch {
    // An engine without week info, or a locale it cannot read.
  }
  return 1;
}

/**
 * The month's weeks from weekStart, seven days each: the neighbouring months' days fill the
 * first and last weeks (the calendar mutes them, as the snooze calendar does).
 */
export function monthGrid(y: number, m: number, weekStart: number): string[][] {
  const first = toIso({ y, m, d: 1 });
  const lead = (weekday(first) - weekStart + 7) % 7;
  const cells = lead + daysIn(y, m);
  const weeks: string[][] = [];
  let day = addDays(first, -lead);
  for (let w = 0; w < Math.ceil(cells / 7); w++) {
    const week: string[] = [];
    for (let i = 0; i < 7; i++) {
      week.push(day);
      day = addDays(day, 1);
    }
    weeks.push(week);
  }
  return weeks;
}

/** Whether iso falls in month m of year y. */
export function inMonth(iso: string, y: number, m: number): boolean {
  return iso.startsWith(`${toIso({ y, m, d: 1 }).slice(0, 7)}-`);
}

/** The weekday names from weekStart, narrow ("M") and long ("Monday"). */
export function weekdayNames(weekStart: number, locale?: string): { narrow: string; long: string }[] {
  const narrow = new Intl.DateTimeFormat(locale, { weekday: "narrow", timeZone: "UTC" });
  const long = new Intl.DateTimeFormat(locale, { weekday: "long", timeZone: "UTC" });
  // 2023-01-01 was a Sunday.
  return Array.from({ length: 7 }, (_, i) => {
    const t = new Date(Date.UTC(2023, 0, 1 + ((weekStart + i) % 7)));
    return { narrow: narrow.format(t), long: long.format(t) };
  });
}

/** "November 2026". */
export function monthTitle(y: number, m: number, locale?: string): string {
  return new Intl.DateTimeFormat(locale, { month: "long", year: "numeric", timeZone: "UTC" }).format(utc({ y, m, d: 1 }));
}

/** A day short for a control: "Sat, Nov 14", with the year when it is not this year's. */
export function formatDay(iso: string, today: string, locale?: string): string {
  const p = parseIso(iso);
  if (!p) return iso;
  const sameYear = p.y === parseIso(today)?.y;
  return new Intl.DateTimeFormat(locale, { weekday: "short", month: "short", day: "numeric", ...(!sameYear && { year: "numeric" }), timeZone: "UTC" }).format(utc(p));
}

/** A day in full, for a calendar cell's name: "Saturday, November 14, 2026". */
export function formatDayLong(iso: string, locale?: string): string {
  const p = parseIso(iso);
  if (!p) return iso;
  return new Intl.DateTimeFormat(locale, { dateStyle: "full", timeZone: "UTC" }).format(utc(p));
}

/** The short weekday ("Mon"), for the next-Monday pick. */
export function weekdayShort(iso: string, locale?: string): string {
  const p = parseIso(iso);
  if (!p) return iso;
  return new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(utc(p));
}

/** The day a calendar key moves the focus to (null: not a key the grid takes): a day, a week, a month, the week's ends. */
export function moveFocus(key: string, focus: string, weekStart: number): string | null {
  switch (key) {
    case "ArrowLeft":
      return addDays(focus, -1);
    case "ArrowRight":
      return addDays(focus, 1);
    case "ArrowUp":
      return addDays(focus, -7);
    case "ArrowDown":
      return addDays(focus, 7);
    case "PageUp":
      return addMonths(focus, -1);
    case "PageDown":
      return addMonths(focus, 1);
    case "Home":
      return addDays(focus, -((weekday(focus) - weekStart + 7) % 7));
    case "End":
      return addDays(focus, 6 - ((weekday(focus) - weekStart + 7) % 7));
  }
  return null;
}

/** The host's check of a date value: an ISO date within min..max; null when it passes (or is empty). */
export function dateError(v: string, min?: string, max?: string, today = todayIso(), locale?: string): string | null {
  if (v === "") return null;
  if (!isIsoDate(v)) return "Not a date (YYYY-MM-DD)";
  if (min && isIsoDate(min) && v < min) return `On or after ${formatDay(min, today, locale)}`;
  if (max && isIsoDate(max) && v > max) return `On or before ${formatDay(max, today, locale)}`;
  return null;
}
