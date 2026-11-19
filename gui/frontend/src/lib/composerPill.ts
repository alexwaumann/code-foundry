/**
 * The pill in the row above a thread's composer (docs/notes/composer-row-pill.md): which
 * segments it has, what each says, and which shortening step makes it fit. Pure.
 */
import { formatAge } from "./duration";
import { snoozeTimeShort } from "./snooze";
import { waitSentence, type WaitCounts } from "./waitList";

/** The pill's segments, left to right. `stop` is Stop waiting on its own, only while the thread is idle. */
export type PillSegment = "working" | "snooze" | "waiting" | "stop" | "jump";

/** What the pill is drawn from. */
export interface PillState {
  /** On a turn: the working segment. */
  working: boolean;
  /** Snoozed, saved for later, or woken from a snooze. */
  snooze: boolean;
  /** Something will wake the thread: the waiting segment. */
  waiting: boolean;
  /** Stop waiting can do something (a subscription or a shell; not subagents alone). */
  canStopWaiting: boolean;
  /** The list is scrolled away from its bottom. */
  away: boolean;
}

/** The segments present, in order; none: the row is empty. Stop waiting is its own segment only while no Working one is there. */
export function pillSegments(s: PillState): PillSegment[] {
  const out: PillSegment[] = [];
  if (s.working) out.push("working");
  if (s.snooze) out.push("snooze");
  if (s.waiting) out.push("waiting");
  if (s.waiting && s.canStopWaiting && !s.working) out.push("stop");
  if (s.away) out.push("jump");
  return out;
}

/**
 * The shortening steps, in the order they apply; each only when the pill still does not fit:
 * 1 the waiting list becomes a count, 2 snooze drops its time, 3 working drops its word,
 * 4 waiting drops its words. Jump to bottom (and Stop waiting) never shrink.
 */
export const PILL_STEPS = 4;
export type PillStep = 0 | 1 | 2 | 3 | 4;

/** The form a segment takes at a step: 0 is its full form. Working and snooze have two forms, waiting three. */
export function segmentForm(seg: PillSegment, step: PillStep): number {
  switch (seg) {
    case "waiting":
      return step >= 4 ? 2 : step >= 1 ? 1 : 0;
    case "snooze":
      return step >= 2 ? 1 : 0;
    case "working":
      return step >= 3 ? 1 : 0;
    default:
      return 0;
  }
}

/**
 * The measured widths of each present segment's forms (index = form; padding, icons and
 * chevron included), and the pill's own: its border and the dividers between segments.
 */
export interface PillWidths {
  segments: Partial<Record<PillSegment, readonly number[]>>;
  /** The border's and the dividers' width. */
  chrome: number;
}

/** The pill's width at a step. */
export function pillWidth(w: PillWidths, step: PillStep): number {
  let total = w.chrome;
  for (const [seg, forms] of Object.entries(w.segments) as [PillSegment, readonly number[]][]) {
    const f = segmentForm(seg, step);
    total += forms[Math.min(f, forms.length - 1)] ?? 0;
  }
  return total;
}

/** The fewest steps that make the pill fit `available`; the last step when nothing fits. */
export function pillStep(w: PillWidths, available: number): PillStep {
  for (let s = 0; s < PILL_STEPS; s++) {
    const step = s as PillStep;
    if (pillWidth(w, step) <= available) return step;
  }
  return PILL_STEPS;
}

/** The snooze segment's state: until a time, saved for later (no alarm), or woken at a time (null: unknown). */
export type PillSnooze = { kind: "snoozed"; until: number } | { kind: "saved" } | { kind: "woken"; at: number | null };

/** "Snooze ended 5m ago", or "Snooze ended" when the time is not known. */
function endedText(at: number | null, now: number): string {
  return at === null ? "Snooze ended" : `Snooze ended ${formatAge(at, now, { days: true, hours: true, minutes: true })}`;
}

/** The segment's full words ("Snoozed until Mon 9:00 AM", "Saved for later", "Snooze ended 5m ago"); its menu's first line too. */
export function snoozeFull(s: PillSnooze, now: number): string {
  switch (s.kind) {
    case "snoozed":
      return `Snoozed until ${snoozeTimeShort(s.until, now)}`;
    case "saved":
      return "Saved for later";
    case "woken":
      return endedText(s.at, now);
  }
}

/** The segment's words without the time: "Snoozed" (saved for later too), "Snooze ended". */
export function snoozeShort(s: PillSnooze): string {
  return s.kind === "woken" ? "Snooze ended" : "Snoozed";
}

/** What the waiting segment names: "2 threads, 1 PR and 1 timer" (the waiting bar's sentence without "Waiting on"). */
export function waitWords(c: WaitCounts): string {
  return waitSentence(c).replace(/^Waiting on /, "");
}

/** How many things the thread waits on: targets, shells and subagents. */
export function waitTotal(c: WaitCounts): number {
  return c.threads + c.pullRequests + c.actionRuns + c.sources + c.timers + c.shells + c.subagents;
}

/**
 * The timer's widest text, for measuring (the shared duration helper shows at most two units
 * of up to two digits under a day: "59m 59s", "23h 59m"), so a ticking timer never changes
 * the pill's form.
 */
export const WIDEST_TIMERS: readonly string[] = ["59m 59s", "23h 59m"];
