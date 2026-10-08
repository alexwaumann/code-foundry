import type { SessionView } from "@/api/session";

/** The one badge a session row shows. Lifecycle wins over activity status. */
export type SessionBadge = "starting" | "closing" | "disconnected" | "busy" | "idle" | "attention" | "unknown";

export function sessionBadge(s: Pick<SessionView, "state" | "status"> | undefined): SessionBadge {
  if (!s) return "unknown";
  switch (s.state) {
    case "disconnected":
    case "starting":
    case "closing":
      return s.state;
    case "connected":
    case "unknown":
      return s.status === "unknown" ? "unknown" : s.status;
  }
}

export const badgeLabels: Record<SessionBadge, string> = {
  starting: "starting",
  closing: "closing",
  disconnected: "disconnected",
  busy: "busy",
  idle: "idle",
  attention: "needs attention",
  unknown: "session",
};

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
