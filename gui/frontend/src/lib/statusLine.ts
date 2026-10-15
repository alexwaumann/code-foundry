/**
 * The second line of a sidebar thread row (docs/notes/thread-list.md): what the thread is
 * doing or waiting on, in words and a colour, and whether "project @ branch" follows.
 * Pure, over the session view; the row renders it (components/sidebar/SidebarRow.tsx).
 */
import type { SessionView } from "@/api/session";
import { formatAgo, sessionBadge, statusKind, statusNote } from "./session";

/**
 * - "place": just "project @ branch" (idle, unknown; whether Claude's process runs never shows)
 * - "working": "Working" (sky), then the place (Claude starting for a message included)
 * - "input": "Needs input · <tool, dialog or reason>" (amber): permission, trust, notification, other dialogs
 * - "question": "Asked a question" (amber); "plan": "Plan ready for review" (amber)
 * - "finished": "Finished <ago>" (emerald)
 * - "error": "Error · <code or reason>" (red): Claude reported an error, or an error status other than interrupted
 * - "interrupted": "Interrupted while working · <ago>" (red): the process ended mid-turn
 * - "snoozeEnded": "Snooze ended · <ago>" (amber): the daemon woke a snoozed thread
 */
export type StatusLineKind = "place" | "working" | "input" | "question" | "plan" | "finished" | "error" | "interrupted" | "snoozeEnded";

export type StatusTone = "muted" | "sky" | "amber" | "emerald" | "red";

export interface StatusLine {
  kind: StatusLineKind;
  /** The tool, dialog text, error code or reason after "Needs input · " / "Error · "; "" for none. */
  detail: string;
  /** When the status began (epoch ms), for "finished", "interrupted" and "snoozeEnded"; null otherwise or when unknown. */
  at: number | null;
}

export const statusTones: Readonly<Record<StatusLineKind, StatusTone>> = {
  place: "muted",
  working: "sky",
  input: "amber",
  question: "amber",
  plan: "amber",
  finished: "emerald",
  error: "red",
  interrupted: "red",
  snoozeEnded: "amber",
};

/** Whether "project @ branch" follows the status text (or stands alone, for "place"). */
export function showsPlace(kind: StatusLineKind): boolean {
  return kind === "place" || kind === "working";
}

const PLACE: StatusLine = { kind: "place", detail: "", at: null };

export function statusLine(s: Pick<SessionView, "state" | "status" | "statusReason" | "statusChangedAtMs"> | undefined): StatusLine {
  if (!s) return PLACE;
  const badge = sessionBadge(s);
  switch (badge) {
    case "busy":
      return { kind: "working", detail: "", at: null };
    case "attention":
    case "error":
      break;
    default:
      return PLACE;
  }
  const kind = statusKind(s);
  switch (kind) {
    case "done":
      return { kind: "finished", detail: "", at: s.statusChangedAtMs };
    case "interrupted":
      return { kind: "interrupted", detail: "", at: s.statusChangedAtMs };
    case "snoozeEnded":
      return { kind: "snoozeEnded", detail: "", at: s.statusChangedAtMs };
    case "question":
      return { kind: "question", detail: "", at: null };
    case "plan":
      return { kind: "plan", detail: "", at: null };
    case "error":
      return { kind: "error", detail: statusNote(s), at: null };
    default:
      return { kind: "input", detail: statusNote(s), at: null };
  }
}

const words: Readonly<Record<StatusLineKind, string>> = {
  place: "",
  working: "Working",
  input: "Needs input",
  question: "Asked a question",
  plan: "Plan ready for review",
  finished: "Finished",
  error: "Error",
  interrupted: "Interrupted while working",
  snoozeEnded: "Snooze ended",
};

/** The status text before the place: "" for "place". `now` only matters when `at` is set. */
export function statusText(l: StatusLine, now: number): string {
  const word = words[l.kind];
  if (l.at !== null) return l.kind === "finished" ? `${word} ${formatAgo(l.at, now)}` : `${word} · ${formatAgo(l.at, now)}`;
  return l.detail ? `${word} · ${l.detail}` : word;
}

/** The tones the thread tooltip's status row comes in: waiting on the user, or failed. */
export type TipStatusTone = Extract<StatusTone, "amber" | "red">;

/**
 * Whether the thread tooltip shows a status row under the name, and in which tone
 * (docs/notes/tooltip-status-reason.md): only for a thread that needs the user (amber) or
 * is in error or was interrupted (red), whose line 2 the row usually truncates. Null for
 * finished, working and idle. The text is `statusText`, untruncated.
 */
export function tipStatusTone(kind: StatusLineKind): TipStatusTone | null {
  const tone = statusTones[kind];
  return tone === "amber" || tone === "red" ? tone : null;
}
