import type { ThreadFlagView, ThreadView } from "@/api/threads";

/**
 * The one badge a thread row shows. It never tells whether Claude's process runs (the
 * daemon starts it on a message and stops it at cache expiry,
 * docs/notes/hide-connection-state.md); the process state only decides where the status
 * alone would mislead:
 * - "attention" (it waits on the user, see isAttention) and "error" (it ended mid-turn or
 *   did not start) always show, so a thread counted as waiting is never shown working;
 * - otherwise starting is "busy" (a message to a stopped thread makes the daemon say busy
 *   at once; a start without one, for an MCP check, keeps the saved status);
 * - a stopped or stopping thread is otherwise "idle" (a busy left by an older daemon
 *   included: nothing runs).
 */
export type ThreadBadge = "busy" | "idle" | "attention" | "error" | "unknown";

export function threadBadge(s: Pick<ThreadView, "state" | "status"> | undefined): ThreadBadge {
  if (!s) return "unknown";
  if (s.status === "attention" || s.status === "error") return s.status;
  if (s.state === "starting") return "busy";
  if (s.state === "closing" || s.state === "disconnected") return "idle";
  return s.status;
}

export const badgeLabels: Record<ThreadBadge, string> = {
  busy: "busy",
  idle: "idle",
  attention: "needs attention",
  error: "error",
  unknown: "thread",
};

/**
 * What a thread is waiting on or why it stopped, classified from the daemon's status
 * reason (the daemon's stream_status.go; the store's "interrupted"). "waiting for …",
 * "plan", "trust", "notification" and "bell" came from the screen detector of terminal
 * threads (removed 2026-10-12) and only survive on rows that stopped before then:
 * - "done": "finished" (a turn ended with output the user has not seen)
 * - "permission": "permission: <dialog question>" or "waiting for approval: <Tool>"
 *   (the latter when no screen read saw the dialog)
 * - "question": "question: <question>" (AskUserQuestion) or "waiting for input" (an open
 *   turn with no prompt box and no pending tool: a question or plan seen without a screen)
 * - "plan": "plan: <dialog text>" (ExitPlanMode approval)
 * - "error": "error: <code>" (a Claude API error at the prompt), or an "error" status with
 *   any other reason
 * - "interrupted": status "error", reason "interrupted" (the process ended mid-turn: a close,
 *   the daemon's stop)
 * - "crashed": status "error", reason "crashed" (the process died mid-turn on its own: no one
 *   stopped it)
 * - "trust": "trust: <dialog text>" (folder trust dialog)
 * - "notification": "notification: <text>" (OSC 9/99/777) or "bell"
 * - "snoozeEnded": "snooze ended" (the daemon woke a snoozed thread; it waits on the user
 *   like a prompt, docs/notes/snooze-threads-1-daemon.md)
 * - "other": everything else, including every busy / idle / unknown status and the
 *   untested "blocked: …", "continue: …", "menu: …" dialogs
 * Only "attention" and "error" statuses are classified; the rest are "other".
 */
export type StatusKind =
  | "done"
  | "permission"
  | "question"
  | "plan"
  | "error"
  | "interrupted"
  | "crashed"
  | "trust"
  | "notification"
  | "snoozeEnded"
  | "other";

const reasonKinds: Readonly<Record<string, StatusKind>> = {
  finished: "done",
  permission: "permission",
  "waiting for approval": "permission",
  question: "question",
  "waiting for input": "question",
  plan: "plan",
  error: "error",
  trust: "trust",
  notification: "notification",
  bell: "notification",
  "snooze ended": "snoozeEnded",
};

/** "permission: Do you want to proceed?" -> ["permission", "Do you want to proceed?"]; no colon -> [reason, ""]. */
function splitReason(reason: string): [string, string] {
  const i = reason.indexOf(": ");
  return i < 0 ? [reason.trim(), ""] : [reason.slice(0, i).trim(), reason.slice(i + 2).trim()];
}

export function statusKind(s: Pick<ThreadView, "status" | "statusReason">): StatusKind {
  if (s.status === "error") return s.statusReason === "interrupted" || s.statusReason === "crashed" ? s.statusReason : "error";
  if (s.status !== "attention") return "other";
  return reasonKinds[splitReason(s.statusReason)[0]] ?? "other";
}

/**
 * The human part of the status reason, after its "<kind>: " prefix: the dialog question for
 * "permission" ("Do you want to proceed?"), the tool name(s) for "waiting for approval"
 * ("Bash"), the question, plan or notification text, the error code. "" when the reason has
 * none ("finished", "bell", "waiting for input", "interrupted", "crashed").
 */
export function statusDetail(s: Pick<ThreadView, "statusReason">): string {
  return splitReason(s.statusReason)[1];
}

/**
 * statusDetail, else the whole reason when it is not just a kind word ("bell", "finished",
 * "waiting for input") or an error status's own text ("daemon restarted"). "" when there is
 * nothing more to say than the kind. For the sidebar's "Needs input · …" and "Error · …".
 */
export function statusNote(s: Pick<ThreadView, "statusReason">): string {
  const [head, detail] = splitReason(s.statusReason);
  if (detail) return detail;
  return head in reasonKinds || head === "interrupted" || head === "crashed" ? "" : head;
}

/**
 * Where a thread sorts in the sidebar's attention block: "prompt" when it waits on the user
 * (a permission, question, plan, trust or other dialog, a notification, a Claude error),
 * "done" for a finished turn the user has not seen, "" when it needs nothing (any status but
 * attention, including error / interrupted). Prompts sort above finished turns.
 */
export type AttentionTier = "prompt" | "done" | "";

export function attentionTier(s: Pick<ThreadView, "status" | "statusReason">): AttentionTier {
  if (s.status !== "attention") return "";
  return statusKind(s) === "done" ? "done" : "prompt";
}

/**
 * The sidebar group an unpinned thread sorts in (lib/tree.ts buildRows): "prompt" (waits on
 * the user, attentionTier, or a plugin's attention flag), "error" (error / interrupted, or a
 * plugin's error flag), "done" (an unseen finished turn), "working" (busy, or Claude
 * starting), "idle" (everything else). The same reading as
 * threadBadge: attention and error win, so a thread waiting on the user never hides in the
 * collapsible Working section (keys/bindings.ts jumpToAttention); a stopped or stopping
 * busy thread is idle.
 */
export type ThreadGroup = "prompt" | "error" | "done" | "idle" | "working";

/**
 * The flag line 2 shows (docs/notes/plugins-3-events-flags-env.md): the first error flag,
 * else the first attention flag (the daemon sends them errors first, then newest first);
 * null without flags.
 */
export function topFlag(s: Partial<Pick<ThreadView, "flags">>): ThreadFlagView | null {
  const flags = s.flags ?? [];
  return flags.find((f) => f.level === "error") ?? flags[0] ?? null;
}

export function isThreadGroup(v: string): v is ThreadGroup {
  return v === "prompt" || v === "error" || v === "done" || v === "idle" || v === "working";
}

/** What a restart would cut off in one thread (restartCutsOff). */
export type CutOff = "working" | "waiting" | "background" | "reporting";

/**
 * What a restart (of the daemon or the app) cuts off, as the daemon's
 * command.ActiveThread counts it: "working" (Claude starting for a message or on a turn),
 * "waiting" (a permission request or question pending), "background" (its background
 * agents or shells), "reporting" (the turn reporting background work that just ended),
 * else null. An idle or stopped thread loses nothing: a message starts it again.
 */
export function restartCutsOff(
  s: Pick<ThreadView, "state" | "status" | "statusReason" | "backgroundAgentsRunning" | "backgroundShellsRunning" | "backgroundWakePending">,
): CutOff | null {
  if (s.state === "starting") return "working";
  if (s.state !== "connected") return null;
  if (s.status === "busy") return "working";
  if (s.status === "attention" && (s.statusReason.startsWith("permission:") || s.statusReason.startsWith("question:"))) return "waiting";
  if (s.backgroundAgentsRunning + s.backgroundShellsRunning > 0) return "background";
  return s.backgroundWakePending ? "reporting" : null;
}

export function threadGroup(s: Pick<ThreadView, "state" | "status" | "statusReason"> & Partial<Pick<ThreadView, "flags">>): ThreadGroup {
  const tier = attentionTier(s);
  if (tier === "prompt") return tier;
  if (s.status === "error") return "error";
  // A plugin's flag: errors sort with errors, attention with prompts, above a finished
  // turn and out of Working.
  const flag = topFlag(s);
  if (flag) return flag.level === "error" ? "error" : "prompt";
  if (tier === "done") return tier;
  return threadBadge(s) === "busy" ? "working" : "idle";
}

/** "just now", "5 min ago", "3 h ago", "2 d ago"; "never" for null. */
export function formatAgo(ms: number | null, now: number = Date.now()): string {
  if (ms === null) return "never";
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 45) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${String(m)} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${String(h)} h ago`;
  return `${String(Math.round(h / 24))} d ago`;
}

/**
 * A compact age for the sidebar's archived rows: whole minutes under an hour ("0m" under a
 * minute, "59m"), whole hours under a day ("23h"), else whole days ("3d"). Rounded down; a
 * time in the future reads "0m".
 */
export function shortAge(ms: number, now: number = Date.now()): string {
  const m = Math.floor(Math.max(0, now - ms) / 60_000);
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h`;
  return `${String(Math.floor(h / 24))}d`;
}
