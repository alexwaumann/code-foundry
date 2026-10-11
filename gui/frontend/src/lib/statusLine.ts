/**
 * The second line of a sidebar thread row (docs/notes/thread-list.md): what the thread is
 * doing or waiting on, in words and a colour, and whether "project · branch" follows.
 * Pure, over the session view; the row renders it (components/sidebar/SidebarRow.tsx).
 */
import type { SessionView } from "@/api/session";
import { formatAgo, sessionBadge, statusKind, statusNote } from "./session";

/**
 * - "place": just "project · branch" (idle, unknown, plain disconnected)
 * - "starting" / "closing": the lifecycle word, then the place (muted)
 * - "working": "Working" (sky), then the place
 * - "input": "Needs input · <tool, dialog or reason>" (amber): permission, trust, notification, other dialogs
 * - "question": "Asked a question" (amber); "plan": "Plan ready for review" (amber)
 * - "finished": "Finished <ago>" (emerald)
 * - "error": "Error · <code or reason>" (red): Claude reported an error, or an error status other than interrupted
 * - "interrupted": "Interrupted while working · <ago>" (red): the process ended mid-turn
 */
export type StatusLineKind = "place" | "starting" | "closing" | "working" | "input" | "question" | "plan" | "finished" | "error" | "interrupted";

export type StatusTone = "muted" | "sky" | "amber" | "emerald" | "red";

export interface StatusLine {
  kind: StatusLineKind;
  /** The tool, dialog text, error code or reason after "Needs input · " / "Error · "; "" for none. */
  detail: string;
  /** When the status began (epoch ms), for "finished" and "interrupted"; null otherwise or when unknown. */
  at: number | null;
}

export const statusTones: Readonly<Record<StatusLineKind, StatusTone>> = {
  place: "muted",
  starting: "muted",
  closing: "muted",
  working: "sky",
  input: "amber",
  question: "amber",
  plan: "amber",
  finished: "emerald",
  error: "red",
  interrupted: "red",
};

/** Whether "project · branch" follows the status text (or stands alone, for "place"). */
export function showsPlace(kind: StatusLineKind): boolean {
  return kind === "place" || kind === "starting" || kind === "closing" || kind === "working";
}

const PLACE: StatusLine = { kind: "place", detail: "", at: null };

export function statusLine(s: Pick<SessionView, "state" | "status" | "statusReason" | "statusChangedAtMs"> | undefined): StatusLine {
  if (!s) return PLACE;
  const badge = sessionBadge(s);
  switch (badge) {
    case "starting":
    case "closing":
      return { kind: badge, detail: "", at: null };
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
  starting: "Starting",
  closing: "Closing",
  working: "Working",
  input: "Needs input",
  question: "Asked a question",
  plan: "Plan ready for review",
  finished: "Finished",
  error: "Error",
  interrupted: "Interrupted while working",
};

/** The status text before the place: "" for "place". `now` only matters when `at` is set. */
export function statusText(l: StatusLine, now: number): string {
  const word = words[l.kind];
  if (l.at !== null) return l.kind === "finished" ? `${word} ${formatAgo(l.at, now)}` : `${word} · ${formatAgo(l.at, now)}`;
  return l.detail ? `${word} · ${l.detail}` : word;
}
