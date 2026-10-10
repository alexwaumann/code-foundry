import { timestampMs } from "@bufbuild/protobuf/wkt";
import { PermissionMode, SessionService, SessionState, SessionStatus, type Session, type SessionEvent } from "@/gen/codefoundry/v1/session_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { orOutdatedDaemon } from "./errors";

export type SessionStateView = "starting" | "connected" | "closing" | "disconnected" | "unknown";
export type SessionStatusView = "busy" | "idle" | "attention" | "unknown";
/** claude --permission-mode, as session.new's `permission` arg spells it; "" = Claude's default. */
export type PermissionModeView = "supervised" | "accept-edits" | "auto" | "";

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
  permissionMode: PermissionModeView;
  /** Ref the session's worktree branch was created from ("" unless createdWorktree). */
  baseRef: string;
  /** session.new made the worktree for this session. */
  createdWorktree: boolean;
  /**
   * The workspace that owns the thread; "" for a project thread (owned by repoId).
   * repoId/worktreePath are where it runs either way.
   */
  workspaceId: string;
  /**
   * The member worktree a queued "Run in…" moves the thread to once it is idle at its
   * prompt; "" when nothing is queued. worktreePath changes when the move happens.
   */
  pendingWorktreePath: string;
  /** The user pinned the thread (session.pin): it sits in the sidebar's Pinned section. */
  pinned: boolean;
  /**
   * Pull requests Claude linked to the conversation (its pr-link transcript records), one
   * per URL, in first-seen order; never shrinks. docs/notes/linked-prs.md.
   */
  linkedPullRequests: LinkedPullRequestView[];
}

/** A pull request linked to a thread. */
export interface LinkedPullRequestView {
  /** "owner/name" */
  slug: string;
  number: number;
  url: string;
  /** When Claude first linked it, epoch ms; null if unknown. */
  linkedAt: number | null;
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

const permissionMap: Record<PermissionMode, PermissionModeView> = {
  [PermissionMode.UNSPECIFIED]: "",
  [PermissionMode.SUPERVISED]: "supervised",
  [PermissionMode.ACCEPT_EDITS]: "accept-edits",
  [PermissionMode.AUTO]: "auto",
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
    permissionMode: permissionMap[s.permissionMode],
    baseRef: s.baseRef,
    createdWorktree: s.createdWorktree,
    workspaceId: s.workspaceId,
    pendingWorktreePath: s.pendingWorktreePath,
    pinned: s.pinned,
    linkedPullRequests: s.linkedPullRequests.map((l) => ({
      slug: l.slug,
      number: l.number,
      url: l.url,
      linkedAt: l.linkedAt ? timestampMs(l.linkedAt) : null,
    })),
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

/**
 * Image types SessionService.StageAttachment accepts, and its per-file limit. The daemon
 * enforces both; the composer checks first so a bad file is rejected before upload.
 */
export const ATTACHMENT_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

/**
 * Uploads an image for a new thread's first prompt; returns the daemon-side path. A
 * daemon older than the RPC fails with OutdatedDaemonError.
 */
export async function stageAttachment(file: { name: string; type: string; arrayBuffer(): Promise<ArrayBuffer> }, conn: DaemonConnection = daemon): Promise<string> {
  const c = await conn.client(SessionService);
  const data = new Uint8Array(await file.arrayBuffer());
  try {
    const res = await c.stageAttachment({ name: file.name, mimeType: file.type, data });
    return res.path;
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}
