/**
 * The second line of a sidebar thread row (docs/notes/thread-list.md): what the thread is
 * doing or waiting on, in words and a colour, and whether "project @ branch" follows.
 * Pure, over the thread view; the row renders it (components/sidebar/SidebarRow.tsx).
 */
import type { ThreadFlagView, ThreadView } from "@/api/threads";
import { formatAgo, threadBadge, statusKind, statusNote, topFlag } from "./thread";
import { isWaiting } from "./waiting";

/**
 * - "place": just "project @ branch" (idle, unknown; whether Claude's process runs never shows)
 * - "working": "Working" (sky), then the place (Claude starting for a message included)
 * - "input": "Needs input · <tool, dialog or reason>" (amber): permission, trust, notification, other dialogs
 * - "question": "Asked a question" (amber); "plan": "Plan ready for review" (amber)
 * - "finished": "Finished <ago>" (emerald)
 * - "error": "Error · <code or reason>" (red): Claude reported an error, or an error status other than interrupted
 * - "interrupted": "Interrupted while working · <ago>" (red): the process ended mid-turn
 * - "crashed": "Crashed while working · <ago>" (red): the process died mid-turn on its own
 * - "snoozeEnded": "Snooze ended · <ago>" (amber): the daemon woke a snoozed thread
 * - "waiting": "Waiting" (muted, an hourglass before it), then the place: the thread ended
 *   its turn while child threads it subscribed to still work (lib/waiting); idle-like
 * - "flagAttention": "<plugin>: <reason>" (amber), "flagError": the same in red: a plugin's
 *   flag (docs/notes/plugins-3-events-flags-env.md). Claude's own prompts and errors win
 *   over a flag; a flag wins over a finished turn and over working.
 * - "transcriptDeleted": "Transcript deleted" (red, a trash icon before it), then the place:
 *   Claude Code deleted the thread's transcript, so it cannot continue
 *   (docs/notes/transcript-deleted.md). Wins over everything: the thread is stopped for good.
 */
export type StatusLineKind =
  | "place"
  | "working"
  | "input"
  | "question"
  | "plan"
  | "finished"
  | "error"
  | "interrupted"
  | "crashed"
  | "snoozeEnded"
  | "waiting"
  | "flagAttention"
  | "flagError"
  | "transcriptDeleted";

export type StatusTone = "muted" | "sky" | "amber" | "emerald" | "red";

export interface StatusLine {
  kind: StatusLineKind;
  /** The tool, dialog text, error code or reason after "Needs input · " / "Error · "; "" for none. */
  detail: string;
  /** When the status began (epoch ms), for "finished", "interrupted", "crashed" and "snoozeEnded"; null otherwise or when unknown. */
  at: number | null;
  /**
   * The plugin flag behind a "flagAttention" or "flagError" line, its name and reason apart
   * (detail joins them as "<pluginName>: <reason>"); absent for every other kind.
   */
  flag?: Pick<ThreadFlagView, "pluginName" | "reason">;
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
  crashed: "red",
  snoozeEnded: "amber",
  waiting: "muted",
  flagAttention: "amber",
  flagError: "red",
  transcriptDeleted: "red",
};

/** Whether "project @ branch" follows the status text (or stands alone, for "place"). */
export function showsPlace(kind: StatusLineKind): boolean {
  return kind === "place" || kind === "working" || kind === "waiting" || kind === "transcriptDeleted";
}

const PLACE: StatusLine = { kind: "place", detail: "", at: null };
const TRANSCRIPT_DELETED: StatusLine = { kind: "transcriptDeleted", detail: "", at: null };

export function statusLine(
  s: (Pick<ThreadView, "state" | "status" | "statusReason" | "statusChangedAtMs"> & Partial<Pick<ThreadView, "flags" | "transcriptMissing">>) | undefined,
): StatusLine {
  if (!s) return PLACE;
  if (s.transcriptMissing) return TRANSCRIPT_DELETED;
  const flag = topFlag(s);
  const badge = threadBadge(s);
  if (badge === "attention" || badge === "error") {
    const line = streamLine(s);
    if (line.kind !== "finished" || !flag) return line;
  }
  if (flag)
    return {
      kind: flag.level === "error" ? "flagError" : "flagAttention",
      detail: `${flag.pluginName}: ${flag.reason}`,
      at: null,
      flag: { pluginName: flag.pluginName, reason: flag.reason },
    };
  if (isWaiting(s)) return { kind: "waiting", detail: "", at: null };
  return badge === "busy" ? { kind: "working", detail: "", at: null } : PLACE;
}

/** The line for a thread Claude left needing attention or in error (threadBadge). */
function streamLine(s: Pick<ThreadView, "status" | "statusReason" | "statusChangedAtMs">): StatusLine {
  const kind = statusKind(s);
  switch (kind) {
    case "done":
      return { kind: "finished", detail: "", at: s.statusChangedAtMs };
    case "interrupted":
    case "crashed":
      return { kind, detail: "", at: s.statusChangedAtMs };
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
  crashed: "Crashed while working",
  snoozeEnded: "Snooze ended",
  waiting: "Waiting",
  flagAttention: "",
  flagError: "",
  transcriptDeleted: "Transcript deleted",
};

/** The status text before the place: "" for "place". `now` only matters when `at` is set. */
export function statusText(l: StatusLine, now: number): string {
  const word = words[l.kind];
  if (word === "") return l.detail;
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
