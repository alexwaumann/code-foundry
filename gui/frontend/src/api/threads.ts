import { timestampMs } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  AgentRunStatus,
  PermissionMode,
  ThreadFlagLevel,
  ThreadKind,
  ThreadReportStatus,
  ThreadState,
  ThreadStatus,
  type AgentRun,
  type Thread,
  type ThreadFlag,
  type ThreadListEvent,
  type UsageBucket,
} from "@/gen/codefoundry/v1/thread_lifecycle_pb";
import { ThreadService } from "@/gen/codefoundry/v1/thread_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { orOutdatedDaemon } from "./errors";

/**
 * Where the thread's Claude process is. The daemon manages it (starts it on a message,
 * stops it at cache expiry) and it is internal to the GUI: nothing on screen says it
 * (docs/notes/hide-connection-state.md). Read it only where behaviour needs it, through
 * lib/thread (threadBadge, threadGroup, restartCutsOff).
 */
export type ThreadStateView = "starting" | "connected" | "closing" | "disconnected" | "unknown";
/**
 * What Claude is doing. Persisted by the daemon: a stopped thread keeps the status it
 * ended with ("attention" with its reason survives a restart). "error" is set on a
 * thread whose process ended mid-turn (statusReason "interrupted", or "crashed" when it died
 * on its own) or did not start.
 */
export type ThreadStatusView = "busy" | "idle" | "attention" | "error" | "unknown";
/** claude --permission-mode, as thread.new's `permission` arg spells it; "" = Claude's default. */
export type PermissionModeView = "supervised" | "accept-edits" | "auto" | "";

/** View model for a thread (Claude Code session plus its worktree and status). Generated types stay inside src/api. */
export interface ThreadView {
  id: string;
  claudeSessionId: string;
  projectId: string;
  worktreePath: string;
  name: string;
  autoNamed: boolean;
  /** name is provisional: the daemon took it from the first prompt; the naming model's title replaces it. Shown muted and italic. */
  nameProvisional: boolean;
  model: string;
  effort: string;
  state: ThreadStateView;
  status: ThreadStatusView;
  /**
   * The reason for status, e.g. "finished", "at prompt", "permission: Bash git push",
   * "question: Which one?", or "interrupted" / "crashed" for "error". Classify it with statusKind / statusDetail (lib/thread), not by hand.
   */
  statusReason: string;
  /** When status or statusReason last changed, epoch ms; null if never known. */
  statusChangedAtMs: number | null;
  createdAtMs: number | null;
  lastActivityAtMs: number | null;
  parentId: string;
  permissionMode: PermissionModeView;
  /** Ref the thread's worktree branch was created from ("" unless createdWorktree). */
  baseRef: string;
  /**
   * Worktree mode: every git project of the set works in its worktree on `branch`
   * (thread.new made them, or shares them with threads on the same branch). False: each
   * project's own checkout.
   */
  createdWorktree: boolean;
  /** The branch of a worktree-mode thread; "" in checkout mode (the checkout's branch shows instead). */
  branch: string;
  /**
   * The project set, sorted by id, projectId (the primary) included; one entry for a
   * single-project thread, none without a project (docs/notes/workspaces-v2-1-threads.md).
   */
  projectIds: string[];
  /**
   * The workspace the thread references (its instructions and skills); "" for none.
   * Independent of projectIds. A thread whose primary is the workspace's folder has an
   * empty projectId.
   */
  workspaceId: string;
  /**
   * The member worktree a queued "Run in…" moves the thread to once it is idle at its
   * prompt; "" when nothing is queued. worktreePath changes when the move happens.
   */
  pendingWorktreePath: string;
  /** The user pinned the thread (thread.pin): it sits in the sidebar's Pinned section. */
  pinned: boolean;
  /**
   * When the user archived the thread (thread.archive), epoch ms; null when it is not
   * archived. An archived thread is stopped, unpinned and has no shells; pinning or
   * sending unarchives it. docs/notes/archive-threads-1-daemon.md.
   */
  archivedAtMs: number | null;
  /**
   * When a snoozed thread wakes (thread.snooze), epoch ms; null when it is not snoozed. A
   * snoozed thread is stopped, unpinned, not archived and has no shells. The daemon
   * wakes it: this becomes null and the thread needs attention with status reason
   * "snooze ended" (statusChangedAtMs = the wake). Pinning, archiving or sending
   * unsnoozes it. docs/notes/snooze-threads-1-daemon.md.
   */
  snoozedUntilMs: number | null;
  /**
   * An effort change (thread.set-effort) not applied yet: `effort` is the
   * new level; Claude restarts with it once the running turn ends.
   */
  effortPending: boolean;
  /**
   * Pull requests Claude linked to the conversation (its pr-link transcript records), one
   * per URL, in first-seen order; never shrinks. docs/notes/linked-prs.md.
   */
  linkedPullRequests: LinkedPullRequestView[];
  /**
   * Token usage of the thread, one bucket per (model, tier, speed, UTC day), sorted by day,
   * model, tier, speed: every transcript it used (a /clear starts a new one) plus every
   * subagent run in agentRuns. docs/notes/session-usage.md.
   */
  usage: UsageBucketView[];
  /** Price of usage in USD at Claude API rates, excluding unpriced buckets. */
  costUsd: number;
  /** Some bucket has no known rate: costUsd is a lower bound; say "unpriced", never $0. */
  unpriced: boolean;
  /**
   * The thread's subagent runs by start time (unknown last); their usage is already in
   * usage. The run count is agentRuns.length (select that, not the array, for a count).
   */
  agentRuns: AgentRunView[];
  /**
   * The thread's context size after its last turn (the last API response's input + cache
   * read + cache write + output tokens); 0 before the first result.
   * docs/notes/rendered-threads-cold-cache.md.
   */
  contextTokens: number;
  /**
   * When the conversation's prompt cache expires (its last result plus the
   * threads.cache_ttl_seconds setting), epoch ms; null before the first result. Past it, the next message re-reads contextTokens.
   */
  cacheExpiresAtMs: number | null;
  /** What re-reading contextTokens costs once the cache expired, USD; 0 when unpriced. */
  contextRereadUsd: number;
  /**
   * Subagent runs running now, nested ones included, and the thread's own background runs
   * among them (spawn depth 1), which keep running after its turn ends
   * (docs/notes/agents-1-daemon.md). The runs in detail: the thread log's `agents`.
   */
  agentsRunning: number;
  backgroundAgentsRunning: number;
  /**
   * The thread's own background shells running now (Bash run_in_background, Monitor),
   * which keep running after its turn ends; 0 once its process ended
   * (docs/notes/background-shells.md).
   */
  backgroundShellsRunning: number;
  /**
   * A background run or shell just ended at the prompt and Claude's turn reporting it has
   * not ended yet (a few seconds): a restart would lose that report (restartCutsOff).
   */
  backgroundWakePending: boolean;
  /**
   * Claude waits to retry a failed API request (a 429, a 529, a 5xx, a connection
   * error); null otherwise. docs/notes/api-retry-note.md.
   */
  retry: ApiRetryView | null;
  /**
   * The thread whose agent created this one (`code-foundry thread new` run from that
   * thread's Claude); "" when the user made it. The creator may since be removed.
   * docs/notes/agents-2-metadata.md.
   */
  createdBy: string;
  /** The creator's name (its id when unnamed) when this thread was created, kept as it was. */
  createdByName: string;
  /** What the thread was started for, in its creator's words; "" when none. */
  brief: string;
  /** Sorted, distinct labels (lowercase letters, digits, - _ . /). */
  labels: string[];
  /** The thread's latest report (thread.report); null when it never reported. */
  report: ThreadReportView | null;
  /**
   * Spending limit in USD at the rates of costUsd; 0 for none. Reaching it while Claude
   * works interrupts the turn: status "attention", statusReason "budget reached".
   */
  budgetUsd: number;
  /**
   * Whether a thread another thread created is shown in the sidebar whatever the
   * threads.show_created_threads setting says (thread.sidebar, thread.new --sidebar); null
   * follows the setting, and is always null on the user's own threads. Effective visibility
   * (the daemon's rule, Thread.in_sidebar): createdBy "" → shown; inSidebar set → it; else
   * the setting (default off: hidden). docs/notes/hidden-children-1-daemon.md.
   */
  inSidebar: boolean | null;
  /**
   * Flags plugins raised on the thread, errors first, then newest first; at most one per
   * plugin. An overlay on status that never changes it: a flagged thread counts as needing
   * attention (isAttention), sorts with prompts or errors (lib/thread threadGroup) and line 2
   * shows the top flag (lib/statusLine). docs/notes/plugins-3-events-flags-env.md.
   */
  flags: ThreadFlagView[];
  /**
   * Who owns the thread when the user does not: "plugin:<name>" for a plugin's own thread
   * (docs/notes/plugins-6-thread-terminal.md). Owned threads are hidden: the threads store
   * keeps them out of `order` (the sidebar, attention, the dock, lineage), and a plugin's
   * thread node shows them. Absent or "" for the user's.
   */
  owner?: string;
  /**
   * The plugins' session environment for the thread's scope changed since its running
   * Claude process started: the header offers thread.restart
   * (docs/notes/plugins-env-restart.md). `pluginEnvChange` says what, by plugin and
   * variable names ("Hello removed CF_HELLO"). Both absent when the process is current
   * or not running.
   */
  pluginEnvStale?: true;
  pluginEnvChange?: string;
  /**
   * The thread is stopped and Claude Code deleted its conversation's transcript (its
   * cleanupPeriodDays setting), so it cannot continue: the daemon refuses a message, a
   * fork and the MCP and slash command queries. The composer is replaced by a note with
   * Archive and Remove, the header and line 2 say "Transcript deleted" (red, sorted with
   * errors). Absent for every other thread. docs/notes/transcript-deleted.md.
   */
  transcriptMissing?: true;
  /**
   * A resident thread's name ("ember"): the daemon's own long-lived agent thread
   * (Thread.kind RESIDENT; docs/notes/ember-1-primitives.md). Kept out of the user's lists
   * like an owned thread (isOwned), whose Watch stream still carries it. Absent for
   * every other thread. `epoch` (its session count) comes with it.
   */
  resident?: string;
  epoch?: number;
}

/** A plugin's flag on a thread. */
export interface ThreadFlagView {
  /** The plugin's name ("gh-actions"). */
  plugin: string;
  /** Its display name ("GitHub Actions"): the reason reads "<pluginName>: <reason>". */
  pluginName: string;
  /** Amber "attention" (it needs the user) or red "error" (something failed). */
  level: "attention" | "error";
  /** One line, at most 80 characters. */
  reason: string;
  setAtMs: number | null;
  /** Cleared by the daemon when the thread is opened. */
  untilSeen: boolean;
}

/** How a thread's task went, as its agent reported it. */
export type ThreadReportStatusView = "done" | "blocked" | "failed" | "progress";

/** A thread's latest report (thread.report). */
export interface ThreadReportView {
  status: ThreadReportStatusView;
  /** At most 1000 characters; "" when none. */
  summary: string;
  /** A compacted JSON object as the agent sent it; "" when none. */
  data: string;
  /** When it was reported, epoch ms; null if unknown. */
  atMs: number | null;
}

/** A thread's pending API retry (Claude's system/api_retry frame). */
export interface ApiRetryView {
  /** Counts from 1 to maxRetries. */
  attempt: number;
  maxRetries: number;
  /** When the retry is due, epoch ms. */
  retryAtMs: number;
  /** The HTTP status of the failed request; 0 for a connection error with no response. */
  errorStatus: number;
  /** Claude's category: "rate_limit", "overloaded", "server_error", ... */
  error: string;
}

/** One subagent run of a thread (a Claude Code Agent tool call). */
export interface AgentRunView {
  /** Claude's agent id. */
  id: string;
  description: string;
  /** "general-purpose", "Explore", ... */
  agentType: string;
  /** As requested, e.g. "haiku"; "" when inherited from the thread. */
  model: string;
  effort: string;
  background: boolean;
  /** "open": still followed (running, or a background run that has not notified); "closed": its result is in. */
  status: "open" | "closed";
  /** 1: spawned by the thread; 2+: by another run. */
  spawnDepth: number;
  startedAtMs: number | null;
  /** The run's own usage, priced like the thread's. */
  usage: UsageBucketView[];
  costUsd: number;
  unpriced: boolean;
}

/** Token counters for one model on one UTC day, priced by the daemon. */
export interface UsageBucketView {
  /** Canonical model id, e.g. "claude-opus-5-5". */
  model: string;
  /** "" or "long" (Haiku 5.5 prompts over 100K tokens). */
  tier: string;
  /** "" (standard) or "fast". */
  speed: string;
  /** UTC "YYYY-MM-DD"; "unknown" for records without a timestamp. */
  day: string;
  requests: number;
  input: number;
  /** Includes thinking tokens. */
  output: number;
  cacheRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  /** USD; 0 when unpriced. */
  costUsd: number;
  unpriced: boolean;
  /** costUsd split by token kind (flat, so sameUsage compares them by value); 0 when unpriced. */
  inputCostUsd: number;
  outputCostUsd: number;
  cacheReadCostUsd: number;
  cacheWrite5mCostUsd: number;
  cacheWrite1hCostUsd: number;
  /** USD the cache reads saved: cacheRead x (input rate - cache read rate); 0 when unpriced. */
  cacheSavingsUsd: number;
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

/**
 * Thread events. retiredUsage is the usage of removed threads summed per (model, tier,
 * speed, day): usage over every thread is the threads' usage plus it. A "retiredUsage"
 * event follows "removed" when the removed thread had usage and carries the whole ledger.
 */
export type ThreadListEventView =
  | { kind: "snapshot"; threads: ThreadView[]; retiredUsage: UsageBucketView[] }
  | { kind: "updated"; thread: ThreadView }
  | { kind: "removed"; id: string }
  | { kind: "retiredUsage"; buckets: UsageBucketView[] };

export const stateMap: Record<ThreadState, ThreadStateView> = {
  [ThreadState.UNSPECIFIED]: "unknown",
  [ThreadState.STARTING]: "starting",
  [ThreadState.CONNECTED]: "connected",
  [ThreadState.CLOSING]: "closing",
  [ThreadState.DISCONNECTED]: "disconnected",
};

export const statusMap: Record<ThreadStatus, ThreadStatusView> = {
  [ThreadStatus.UNSPECIFIED]: "unknown",
  [ThreadStatus.BUSY]: "busy",
  [ThreadStatus.IDLE]: "idle",
  [ThreadStatus.NEEDS_ATTENTION]: "attention",
  [ThreadStatus.ERROR]: "error",
};

const permissionMap: Record<PermissionMode, PermissionModeView> = {
  [PermissionMode.UNSPECIFIED]: "",
  [PermissionMode.SUPERVISED]: "supervised",
  [PermissionMode.ACCEPT_EDITS]: "accept-edits",
  [PermissionMode.AUTO]: "auto",
};

export function toThreadView(s: Thread): ThreadView {
  return {
    id: s.id,
    claudeSessionId: s.claudeSessionId,
    projectId: s.projectId,
    worktreePath: s.worktreePath,
    name: s.name,
    autoNamed: s.autoNamed,
    nameProvisional: s.nameProvisional,
    model: s.model,
    effort: s.effort,
    state: stateMap[s.state],
    status: statusMap[s.status],
    statusReason: s.statusReason,
    statusChangedAtMs: s.statusChangedAt ? timestampMs(s.statusChangedAt) : null,
    createdAtMs: s.createdAt ? timestampMs(s.createdAt) : null,
    lastActivityAtMs: s.lastActivityAt ? timestampMs(s.lastActivityAt) : null,
    parentId: s.parentId,
    permissionMode: permissionMap[s.permissionMode],
    baseRef: s.baseRef,
    createdWorktree: s.createdWorktree,
    branch: s.branch,
    projectIds: [...s.projectIds],
    workspaceId: s.workspaceId,
    pendingWorktreePath: s.pendingWorktreePath,
    pinned: s.pinned,
    archivedAtMs: s.archivedAt ? timestampMs(s.archivedAt) : null,
    snoozedUntilMs: s.snoozedUntil ? timestampMs(s.snoozedUntil) : null,
    effortPending: s.effortPending,
    linkedPullRequests: s.linkedPullRequests.map((l) => ({
      slug: l.slug,
      number: l.number,
      url: l.url,
      linkedAt: l.linkedAt ? timestampMs(l.linkedAt) : null,
    })),
    usage: s.usage.map(toUsageBucketView),
    costUsd: s.costUsd,
    unpriced: s.unpriced,
    agentRuns: s.agentRuns.map(toAgentRunView),
    contextTokens: Number(s.contextTokens),
    cacheExpiresAtMs: s.cacheExpiresAt ? timestampMs(s.cacheExpiresAt) : null,
    contextRereadUsd: s.contextRereadUsd,
    agentsRunning: s.agentsRunning,
    backgroundAgentsRunning: s.backgroundAgentsRunning,
    backgroundShellsRunning: s.backgroundShellsRunning,
    backgroundWakePending: s.backgroundWakePending,
    retry: s.retry
      ? { attempt: s.retry.attempt, maxRetries: s.retry.maxRetries, retryAtMs: s.retry.retryAt ? timestampMs(s.retry.retryAt) : 0, errorStatus: s.retry.errorStatus, error: s.retry.error }
      : null,
    createdBy: s.createdBy,
    createdByName: s.createdByName,
    brief: s.brief,
    labels: [...s.labels],
    report: toThreadReportView(s),
    budgetUsd: s.budgetUsd,
    inSidebar: s.inSidebar ?? null,
    flags: s.flags.flatMap(toThreadFlagView),
    ...(s.owner ? { owner: s.owner } : {}),
    ...(s.pluginEnvStale ? { pluginEnvStale: true as const, pluginEnvChange: s.pluginEnvChange } : {}),
    ...(s.transcriptMissing ? { transcriptMissing: true as const } : {}),
    ...(s.kind === ThreadKind.RESIDENT ? { resident: s.residentName, epoch: s.epoch } : {}),
  };
}

const flagLevelMap: Record<ThreadFlagLevel, ThreadFlagView["level"] | null> = {
  [ThreadFlagLevel.UNSPECIFIED]: null,
  [ThreadFlagLevel.ATTENTION]: "attention",
  [ThreadFlagLevel.ERROR]: "error",
};

/** A flag's view; none for a level this GUI does not know. */
export function toThreadFlagView(f: ThreadFlag): ThreadFlagView[] {
  const level = flagLevelMap[f.level] ?? null;
  if (level === null) return [];
  return [
    {
      plugin: f.plugin,
      pluginName: f.pluginDisplayName || f.plugin,
      level,
      reason: f.reason,
      setAtMs: f.setAt ? timestampMs(f.setAt) : null,
      untilSeen: f.untilSeen,
    },
  ];
}

export const reportStatusMap: Record<ThreadReportStatus, ThreadReportStatusView | null> = {
  [ThreadReportStatus.UNSPECIFIED]: null,
  [ThreadReportStatus.DONE]: "done",
  [ThreadReportStatus.BLOCKED]: "blocked",
  [ThreadReportStatus.FAILED]: "failed",
  [ThreadReportStatus.PROGRESS]: "progress",
};

/** The thread's report, or null when it has none (an unknown status from a newer daemon is none too). */
export function toThreadReportView(s: Thread): ThreadReportView | null {
  const status = reportStatusMap[s.reportStatus] ?? null;
  if (!status) return null;
  return { status, summary: s.reportSummary, data: s.reportData, atMs: s.reportAt ? timestampMs(s.reportAt) : null };
}

export function toAgentRunView(r: AgentRun): AgentRunView {
  return {
    id: r.id,
    description: r.description,
    agentType: r.agentType,
    model: r.model,
    effort: r.effort,
    background: r.background,
    status: r.status === AgentRunStatus.OPEN ? "open" : "closed",
    spawnDepth: r.spawnDepth,
    startedAtMs: r.startedAt ? timestampMs(r.startedAt) : null,
    usage: r.usage.map(toUsageBucketView),
    costUsd: r.costUsd,
    unpriced: r.unpriced,
  };
}

export function toUsageBucketView(b: UsageBucket): UsageBucketView {
  return {
    model: b.model,
    tier: b.tier,
    speed: b.speed,
    day: b.day,
    requests: Number(b.requests),
    input: Number(b.input),
    output: Number(b.output),
    cacheRead: Number(b.cacheRead),
    cacheWrite5m: Number(b.cacheWrite5m),
    cacheWrite1h: Number(b.cacheWrite1h),
    costUsd: b.costUsd,
    unpriced: b.unpriced,
    inputCostUsd: b.inputCostUsd,
    outputCostUsd: b.outputCostUsd,
    cacheReadCostUsd: b.cacheReadCostUsd,
    cacheWrite5mCostUsd: b.cacheWrite5mCostUsd,
    cacheWrite1hCostUsd: b.cacheWrite1hCostUsd,
    cacheSavingsUsd: b.cacheSavingsUsd,
  };
}

export function toThreadListEventView(ev: ThreadListEvent): ThreadListEventView | null {
  const e = ev.event;
  switch (e.case) {
    case "snapshot":
      return { kind: "snapshot", threads: e.value.threads.map(toThreadView), retiredUsage: e.value.retiredUsage.map(toUsageBucketView) };
    case "updated":
      return { kind: "updated", thread: toThreadView(e.value) };
    case "removedId":
      return { kind: "removed", id: e.value };
    case "retiredUsage":
      return { kind: "retiredUsage", buckets: e.value.buckets.map(toUsageBucketView) };
    default:
      return null;
  }
}

export async function listThreads(conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<ThreadView[]> {
  const c = await conn.client(ThreadService);
  const res = await c.list({}, { signal });
  return res.threads.map(toThreadView);
}

export const PDF_MIME_TYPE = "application/pdf";

/**
 * The types ThreadService.StageAttachment accepts and its limits: 10 MiB per image,
 * 20 MiB per PDF, and 24 MiB for what one message sends inline (its images and its PDFs
 * of at most MAX_INLINE_PDF_PAGES pages; a longer PDF goes as its path only and Claude
 * reads it page by page). The daemon enforces all of them; the composer checks first so
 * a bad file is rejected before upload.
 */
export const ATTACHMENT_MIME_TYPES: readonly string[] = ["image/png", "image/jpeg", "image/gif", "image/webp", PDF_MIME_TYPE];
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const PDF_MAX_BYTES = 20 * 1024 * 1024;
export const MESSAGE_INLINE_MAX_BYTES = 24 * 1024 * 1024;
export const MAX_INLINE_PDF_PAGES = 10;

/** The per-file limit for an attachment type. */
export function attachmentMaxBytes(type: string): number {
  return type === PDF_MIME_TYPE ? PDF_MAX_BYTES : IMAGE_MAX_BYTES;
}

/**
 * A staged attachment's bytes (a user message shows its images and PDFs); null
 * once the daemon reaped it. Rejects when the daemon could not be asked.
 */
export async function readAttachment(path: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<{ data: Uint8Array; mimeType: string } | null> {
  const c = await conn.client(ThreadService);
  try {
    const res = await c.readAttachment({ path }, { signal });
    return { data: res.data, mimeType: res.mimeType };
  } catch (err) {
    // Gone for good (reaped, or not a staged image): null. Anything else (the daemon is
    // down or restarting, an older daemon) is worth another try later.
    if (err instanceof ConnectError && (err.code === Code.NotFound || err.code === Code.InvalidArgument)) return null;
    throw err;
  }
}

/**
 * Uploads an image or a PDF for a message; returns the daemon-side path. `pages` is a
 * PDF's page count from pdf.js (null when not counted): the daemon takes it when it has
 * no pdfinfo, so both agree on what goes inline. A daemon older than the RPC fails with
 * OutdatedDaemonError.
 */
export async function stageAttachment(file: { name: string; type: string; arrayBuffer(): Promise<ArrayBuffer> }, pages: number | null = null, conn: DaemonConnection = daemon): Promise<string> {
  const c = await conn.client(ThreadService);
  const data = new Uint8Array(await file.arrayBuffer());
  try {
    const res = await c.stageAttachment({ name: file.name, mimeType: file.type, data, pages: pages ?? 0 });
    return res.path;
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}

/**
 * Stages the file at an absolute path (one dropped on the composer or picked in the
 * native file dialog; the Wails host hands over paths, WebKit never does) without
 * uploading its bytes: the daemon reads it, sniffs the type, applies the same limits
 * and page count as stageAttachment, and returns the daemon-side path. Unsupported
 * content fails with InvalidArgument and the same message as an unsupported type
 * (shown as the composer notice); a missing file with NotFound. `pages` is a hint like
 * stageAttachment's.
 */
export async function stageAttachmentPath(path: string, pages: number | null = null, conn: DaemonConnection = daemon): Promise<string> {
  const c = await conn.client(ThreadService);
  try {
    const res = await c.stageAttachment({ path, pages: pages ?? 0 });
    return res.path;
  } catch (err) {
    throw orOutdatedDaemon(err);
  }
}
