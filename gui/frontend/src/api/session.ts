import { timestampMs } from "@bufbuild/protobuf/wkt";
import { SessionService, SessionState, SessionStatus, type Session, type SessionEvent } from "@/gen/codefoundry/v1/session_pb";
import { daemon, type DaemonConnection } from "./endpoint";

export type SessionStateView = "starting" | "connected" | "closing" | "disconnected" | "unknown";
export type SessionStatusView = "busy" | "idle" | "attention" | "unknown";

/** View model for a Claude session. Generated types stay inside src/api. */
export interface SessionView {
  id: string;
  claudeSessionId: string;
  repoId: string;
  worktreePath: string;
  name: string;
  autoNamed: boolean;
  model: string;
  effort: string;
  /** Attached terminal; "" when disconnected. */
  terminalId: string;
  state: SessionStateView;
  status: SessionStatusView;
  createdAtMs: number | null;
  lastActivityAtMs: number | null;
  exitCode: number;
  /** "closed" | "exited" | "crashed" | "" */
  disconnectReason: string;
  lastError: string;
  parentId: string;
}

export type SessionEventView =
  | { kind: "snapshot"; sessions: SessionView[] }
  | { kind: "updated"; session: SessionView }
  | { kind: "removed"; id: string };

const stateMap: Record<SessionState, SessionStateView> = {
  [SessionState.UNSPECIFIED]: "unknown",
  [SessionState.STARTING]: "starting",
  [SessionState.CONNECTED]: "connected",
  [SessionState.CLOSING]: "closing",
  [SessionState.DISCONNECTED]: "disconnected",
};

const statusMap: Record<SessionStatus, SessionStatusView> = {
  [SessionStatus.UNSPECIFIED]: "unknown",
  [SessionStatus.BUSY]: "busy",
  [SessionStatus.IDLE]: "idle",
  [SessionStatus.NEEDS_ATTENTION]: "attention",
};

export function toSessionView(s: Session): SessionView {
  return {
    id: s.id,
    claudeSessionId: s.claudeSessionId,
    repoId: s.repoId,
    worktreePath: s.worktreePath,
    name: s.name,
    autoNamed: s.autoNamed,
    model: s.model,
    effort: s.effort,
    terminalId: s.terminalId,
    state: stateMap[s.state],
    status: statusMap[s.status],
    createdAtMs: s.createdAt ? timestampMs(s.createdAt) : null,
    lastActivityAtMs: s.lastActivityAt ? timestampMs(s.lastActivityAt) : null,
    exitCode: s.exitCode,
    disconnectReason: s.disconnectReason,
    lastError: s.lastError,
    parentId: s.parentId,
  };
}

export function toSessionEventView(ev: SessionEvent): SessionEventView | null {
  const e = ev.event;
  switch (e.case) {
    case "snapshot":
      return { kind: "snapshot", sessions: e.value.sessions.map(toSessionView) };
    case "updated":
      return { kind: "updated", session: toSessionView(e.value) };
    case "removedId":
      return { kind: "removed", id: e.value };
    default:
      return null;
  }
}

export async function listSessions(conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<SessionView[]> {
  const c = await conn.client(SessionService);
  const res = await c.list({}, { signal });
  return res.sessions.map(toSessionView);
}
