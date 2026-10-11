import type { RepoView, WorktreeView } from "@/api/repo";
import type { SessionView } from "@/api/session";
import { choiceLabel, MODEL_CHOICES } from "./compose";
import { basename } from "./path";
import { placeSession } from "./tree";

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

/**
 * The disconnected page's status pill, from the status the thread persisted when it
 * disconnected: what Claude was doing. "interrupted" (red) for an error status (the store
 * sets error only as "interrupted", when the process ends mid-turn), "attention" (amber)
 * for a thread that was waiting on the user, "idle" (hollow ring) for one at its prompt,
 * "none" (no dot, no label: the pill shows only the cause) for busy / unknown, which a
 * disconnected thread should not have.
 */
export type PillKind = "interrupted" | "attention" | "idle" | "none";

export function disconnectedPill(s: Pick<SessionView, "status" | "statusReason">): { kind: PillKind; label: string } {
  switch (s.status) {
    case "error":
      return { kind: "interrupted", label: "Interrupted" };
    case "attention":
      return { kind: "attention", label: "Was waiting on you" };
    case "idle":
      return { kind: "idle", label: s.statusReason === "finished" ? "Finished" : "At prompt" };
    case "busy":
    case "unknown":
      return { kind: "none", label: "" };
  }
}

/**
 * disconnectReason as the pill's second half: lowercased ("closed", "crashed (exit code 1)",
 * "stopped: <err>"), except "Claude exited…", which keeps Claude's capital.
 */
export function disconnectCause(s: Pick<SessionView, "disconnectReason" | "exitCode" | "lastError">): string {
  const r = disconnectReason(s);
  return r.startsWith("Claude ") ? r : r.charAt(0).toLowerCase() + r.slice(1);
}

/** "Opus 5.5 (high)", the composer's model name (the raw id when unknown) and the effort; "" without a model. */
export function modelLabel(s: Pick<SessionView, "model" | "effort">): string {
  if (!s.model) return "";
  const name = choiceLabel(MODEL_CHOICES, s.model);
  return s.effort ? `${name} (${s.effort})` : name;
}

/** The repos store slice sessionLocation reads. */
export interface LocationRepos {
  order: readonly string[];
  byId: Readonly<Record<string, (Pick<RepoView, "name" | "git"> & { worktrees: readonly Pick<WorktreeView, "path" | "branch" | "head" | "detached">[] }) | undefined>>;
}

/**
 * Where a thread runs, as "<project> @ <branch>": the registered project and worktree its
 * worktree path places in (placeSession). branch is the worktree's branch, or the short
 * head (7 chars) when detached; "" for a project without git (show the project alone).
 * A thread that cannot be placed shows its worktree directory's name as the project.
 */
export function sessionLocation(s: Pick<SessionView, "worktreePath">, repos: LocationRepos): { project: string; branch: string } {
  const worktrees = repos.order.flatMap((id) => repos.byId[id]?.worktrees.map((w) => ({ repoId: id, path: w.path })) ?? []);
  const place = placeSession(s, worktrees);
  const repo = place ? repos.byId[place.repoId] : undefined;
  const w = place ? repo?.worktrees.find((x) => x.path === place.path) : undefined;
  if (!repo || !w) return { project: basename(s.worktreePath), branch: "" };
  if (!repo.git) return { project: repo.name, branch: "" };
  const short = w.head.slice(0, 7);
  return { project: repo.name, branch: w.detached ? short || w.branch : w.branch || short };
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
