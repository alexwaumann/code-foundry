import type { SessionView } from "@/api/session";

/**
 * The one badge a session row shows. Lifecycle wins over activity status, except that a
 * disconnected session shows the status it persisted when that status still matters:
 * "attention" (it was waiting on the user; it still is, and counts as attention, see
 * isAttention) or "error" (its process ended mid-turn: interrupted). A disconnected session
 * that was idle or unknown shows "disconnected".
 */
export type SessionBadge = "starting" | "closing" | "disconnected" | "busy" | "idle" | "attention" | "error" | "unknown";

export function sessionBadge(s: Pick<SessionView, "state" | "status"> | undefined): SessionBadge {
  if (!s) return "unknown";
  switch (s.state) {
    case "starting":
    case "closing":
      return s.state;
    case "disconnected":
      return s.status === "attention" || s.status === "error" ? s.status : "disconnected";
    case "connected":
    case "unknown":
      return s.status;
  }
}

export const badgeLabels: Record<SessionBadge, string> = {
  starting: "starting",
  closing: "closing",
  disconnected: "disconnected",
  busy: "busy",
  idle: "idle",
  attention: "needs attention",
  error: "error",
  unknown: "thread",
};

/**
 * What a session is waiting on or why it stopped, classified from the daemon's status
 * reason (internal/claudestatus restingStatus; the store's "interrupted"):
 * - "done": "finished" (a turn ended with output the user has not seen)
 * - "permission": "permission: <dialog question>" or "waiting for approval: <Tool>"
 *   (the latter when no screen read saw the dialog)
 * - "question": "question: <question>" (AskUserQuestion) or "waiting for input" (an open
 *   turn with no prompt box and no pending tool: a question or plan seen without a screen)
 * - "plan": "plan: <dialog text>" (ExitPlanMode approval)
 * - "error": "error: <code>" (a Claude API error at the prompt), or an "error" status with
 *   any other reason
 * - "interrupted": status "error", reason "interrupted" (the process ended mid-turn)
 * - "trust": "trust: <dialog text>" (folder trust dialog)
 * - "notification": "notification: <text>" (OSC 9/99/777) or "bell"
 * - "other": everything else, including every busy / idle / unknown status and the
 *   untested "blocked: …", "continue: …", "menu: …" dialogs
 * Only "attention" and "error" statuses are classified; the rest are "other".
 */
export type StatusKind = "done" | "permission" | "question" | "plan" | "error" | "interrupted" | "trust" | "notification" | "other";

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
};

/** "permission: Do you want to proceed?" -> ["permission", "Do you want to proceed?"]; no colon -> [reason, ""]. */
function splitReason(reason: string): [string, string] {
  const i = reason.indexOf(": ");
  return i < 0 ? [reason.trim(), ""] : [reason.slice(0, i).trim(), reason.slice(i + 2).trim()];
}

export function statusKind(s: Pick<SessionView, "status" | "statusReason">): StatusKind {
  if (s.status === "error") return s.statusReason === "interrupted" ? "interrupted" : "error";
  if (s.status !== "attention") return "other";
  return reasonKinds[splitReason(s.statusReason)[0]] ?? "other";
}

/**
 * The human part of the status reason, after its "<kind>: " prefix: the dialog question for
 * "permission" ("Do you want to proceed?"), the tool name(s) for "waiting for approval"
 * ("Bash"), the question, plan or notification text, the error code. "" when the reason has
 * none ("finished", "bell", "waiting for input", "interrupted").
 */
export function statusDetail(s: Pick<SessionView, "statusReason">): string {
  return splitReason(s.statusReason)[1];
}

/**
 * statusDetail, else the whole reason when it is not just a kind word ("bell", "finished",
 * "waiting for input") or an error status's own text ("daemon restarted"). "" when there is
 * nothing more to say than the kind. For the sidebar's "Needs input · …" and "Error · …".
 */
export function statusNote(s: Pick<SessionView, "statusReason">): string {
  const [head, detail] = splitReason(s.statusReason);
  if (detail) return detail;
  return head in reasonKinds || head === "interrupted" ? "" : head;
}

/**
 * Where a thread sorts in the sidebar's attention block: "prompt" when it waits on the user
 * (a permission, question, plan, trust or other dialog, a notification, a Claude error),
 * "done" for a finished turn the user has not seen, "" when it needs nothing (any status but
 * attention, including error / interrupted). Prompts sort above finished turns.
 */
export type AttentionTier = "prompt" | "done" | "";

export function attentionTier(s: Pick<SessionView, "status" | "statusReason">): AttentionTier {
  if (s.status !== "attention") return "";
  return statusKind(s) === "done" ? "done" : "prompt";
}

/** Why a session is not connected, for the "Not connected" panel. */
export function disconnectReason(s: Pick<SessionView, "disconnectReason" | "exitCode" | "lastError">): string {
  switch (s.disconnectReason) {
    case "closed":
      return "Closed";
    case "exited":
      return s.exitCode === 0 ? "Claude exited" : `Claude exited with code ${String(s.exitCode)}`;
    case "crashed":
      return `Crashed (exit code ${String(s.exitCode)})`;
    case "":
      return s.lastError ? `Stopped: ${s.lastError}` : "Not running";
    default:
      return s.disconnectReason;
  }
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
