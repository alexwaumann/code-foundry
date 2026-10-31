/**
 * The sidebar inbox row's status (docs/notes/sidebar-inbox-2-libs.md): one entry per
 * StatusLineKind (lib/statusLine.ts) with the icon, word and tone line 1 shows on the
 * right, and which time follows it; statusDetail is line 3's text. Pure; the row
 * (components/sidebar/SidebarRow.tsx) renders it.
 *
 * Attention, error and done kinds show no time on the row (the hover card has it).
 * Working and waiting show the time since the status changed, in the word's tone. Idle
 * (place) shows no icon or word, only the time since the last activity, muted.
 */
import {
  BellRing,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleQuestionMark,
  ClipboardCheck,
  Flag,
  ShieldQuestionMark,
  TriangleAlert,
  Unplug,
  type LucideIcon,
} from "lucide-react";
import type { ThreadView } from "@/api/threads";
import type { StatusLine, StatusLineKind } from "./statusLine";
import { statusNote } from "./thread";
import { waitingCount } from "./waiting";

/** The row's status tones. */
export type RowTone = "warning" | "error" | "success" | "info" | "muted";

/** The text colour class of each tone (a modifier after the line's type role). */
export const rowToneClasses: Readonly<Record<RowTone, string>> = {
  warning: "text-cf-warning-text",
  error: "text-cf-error-text",
  success: "text-cf-success-text",
  info: "text-cf-info-text",
  muted: "text-cf-sidebar-muted-foreground",
};

/**
 * Which time line 1 shows after the word:
 * - "none": no time (attention, error and done kinds; the hover card shows it)
 * - "status": elapsed since statusChangedAtMs, in the entry's tone (working, waiting)
 * - "activity": elapsed since lastActivityAtMs, muted (place, the idle row)
 */
export type TimeMode = "none" | "status" | "activity";

export interface StatusEntry {
  /** The glyph before the word; null for place (idle shows only its time). */
  icon: LucideIcon | null;
  /** The word; "" for place, and for the flag kinds, whose word is the plugin's name (statusBadge). */
  word: string;
  tone: RowTone;
  timeMode: TimeMode;
}

/** The registry: every StatusLineKind, so a new kind fails to compile until it has an entry. */
export const statusRegistry: Readonly<Record<StatusLineKind, StatusEntry>> = {
  input: { icon: ShieldQuestionMark, word: "Permission", tone: "warning", timeMode: "none" },
  question: { icon: CircleQuestionMark, word: "Question", tone: "warning", timeMode: "none" },
  plan: { icon: ClipboardCheck, word: "Plan", tone: "warning", timeMode: "none" },
  flagAttention: { icon: Flag, word: "", tone: "warning", timeMode: "none" },
  flagError: { icon: Flag, word: "", tone: "error", timeMode: "none" },
  snoozeEnded: { icon: BellRing, word: "Woke", tone: "warning", timeMode: "none" },
  error: { icon: CircleAlert, word: "Error", tone: "error", timeMode: "none" },
  interrupted: { icon: Unplug, word: "Interrupted", tone: "error", timeMode: "none" },
  crashed: { icon: TriangleAlert, word: "Crashed", tone: "error", timeMode: "none" },
  transcriptDeleted: { icon: CircleAlert, word: "Error", tone: "error", timeMode: "none" },
  finished: { icon: CircleCheck, word: "Done", tone: "success", timeMode: "none" },
  working: { icon: CircleDashed, word: "Working", tone: "info", timeMode: "status" },
  waiting: { icon: CircleDashed, word: "Waiting", tone: "muted", timeMode: "status" },
  place: { icon: null, word: "", tone: "muted", timeMode: "activity" },
};

/** A line's entry resolved for rendering: the flag kinds get the plugin's name as their word, and the tone's class. */
export interface StatusBadge extends StatusEntry {
  toneClass: string;
}

export function statusBadge(line: StatusLine): StatusBadge {
  const entry = statusRegistry[line.kind];
  const word = line.kind === "flagAttention" || line.kind === "flagError" ? (line.flag?.pluginName ?? "") : entry.word;
  return { ...entry, word, toneClass: rowToneClasses[entry.tone] };
}

/**
 * The thread fields statusDetail reads. busyTool (the tool a working turn runs,
 * "Bash make check") is optional so this compiles before and after ThreadView has it.
 */
export type StatusDetailThread = Pick<ThreadView, "status" | "statusReason"> & { busyTool?: string };

/**
 * Line 3's detail text for a line, "" when the row shows the branch instead:
 * - input: the tool and its command ("Bash zig build …"), or the dialog text (statusNote)
 * - question: the question text; plan: "ready for review"
 * - flagAttention / flagError: the flag's reason
 * - snoozeEnded: "snooze ended"; error: the error note (statusNote)
 * - interrupted / crashed: "resend to continue"; transcriptDeleted: "transcript deleted"
 * - working: the current tool (busyTool), "compacting" while Claude compacts, else ""
 * - waiting: "2 child threads", "1 child thread", or "a queued wake" when only a wake keeps it
 * - finished, place: ""
 * Not lib/thread.ts statusDetail (the reason's part after "<kind>: "), which this builds on.
 */
export function statusDetail(line: StatusLine, thread: StatusDetailThread | undefined): string {
  switch (line.kind) {
    case "input":
    case "question":
    case "error":
      return line.detail || (thread ? statusNote(thread) : "");
    case "plan":
      return "ready for review";
    case "flagAttention":
    case "flagError":
      return line.flag?.reason ?? "";
    case "snoozeEnded":
      return "snooze ended";
    case "interrupted":
    case "crashed":
      return "resend to continue";
    case "transcriptDeleted":
      return "transcript deleted";
    case "working":
      if (!thread) return "";
      return thread.statusReason === "compacting" ? "compacting" : (thread.busyTool ?? "");
    case "waiting":
      return thread ? waitingDetail(waitingCount(thread)) : "";
    case "finished":
    case "place":
      return "";
  }
}

function waitingDetail(n: number): string {
  if (n <= 0) return "a queued wake";
  return n === 1 ? "1 child thread" : `${String(n)} child threads`;
}

/**
 * The time line 1's elapsed counts from (epoch ms) for the entry's timeMode: the status
 * change for "status", the last activity for "activity", null for "none" or when unknown.
 * Format it with lib/elapsed.ts formatElapsed.
 */
export function statusTimeAt(line: StatusLine, thread: Partial<Pick<ThreadView, "statusChangedAtMs" | "lastActivityAtMs">> | undefined): number | null {
  switch (statusRegistry[line.kind].timeMode) {
    case "status":
      return thread?.statusChangedAtMs ?? null;
    case "activity":
      return thread?.lastActivityAtMs ?? null;
    case "none":
      return null;
  }
}
