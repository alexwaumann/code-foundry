/**
 * Threads: the conversation the daemon records as items (ThreadService) mapped to view
 * models. Generated types stay in this file. Sync rules
 * (docs/notes/rendered-threads-1-daemon.md): ThreadService.WatchThread sends a snapshot first,
 * then appended / updated items, text deltas and pending-request changes, each with the
 * thread's seq. The EventService `thread` source carries only pending requests (a
 * pending_snapshot, then a pending event per change), for badges without a Watch.
 */
import { timestampMs } from "@bufbuild/protobuf/wkt";
import {
  MessageOrigin,
  ThreadItemDelta_Field,
  ThreadRequestState,
  ThreadService,
  ToolCallStatus,
  type ThreadEvent,
  type ThreadItem,
  type ThreadPendingRequest,
  type ThreadRequestItem,
} from "@/gen/codefoundry/v1/thread_pb";
import { daemon, type DaemonConnection } from "./endpoint";
import { HEARTBEAT, type Heartbeat } from "./stream";
import { toAgentRunViews, type AgentRunView } from "./agents";
import { toMcpStatusView, type McpStatusView } from "./mcp";
import { toSlashCommandViews, type SlashCommandView } from "./slashCommands";

export type ToolStatusView = "running" | "done" | "error" | "unknown";
export type RequestStateView = "pending" | "allowed" | "denied" | "cancelled" | "unknown";

/** A permission prompt (can_use_tool) or an AskUserQuestion, and how it was resolved. */
export interface ThreadRequestView {
  /** Answer with ThreadService.Respond(requestId); "" for an auto-denied call. */
  requestId: string;
  toolName: string;
  displayName: string;
  title: string;
  /** What the call touches, e.g. a file name. */
  description: string;
  /** The tool_call item this request is about. */
  toolUseId: string;
  /** Set when a subagent asked. */
  agentId: string;
  blockedPath: string;
  decisionReason: string;
  /** The tool's input JSON (a question's: {questions: [...]}) */
  inputJson: string;
  /** Claude's permission_suggestions as JSON; "" when none. */
  suggestionsJson: string;
  state: RequestStateView;
  /** "allow", "allow_session", "deny" or "auto_denied" once resolved. */
  decision: string;
  /** The deny message, or why it was cancelled. */
  message: string;
  /** A question's answers: question -> chosen label(s), several joined with ", ". */
  answers: Readonly<Record<string, string>>;
}

interface ItemBase {
  id: string;
  /** Order in the thread; only grows, not dense. */
  ordinal: number;
  /** The Agent tool_use a subagent's item belongs to; "" for the thread's own. */
  parentToolUseId: string;
  createdAtMs: number | null;
  updatedAtMs: number | null;
  /** Text or tool input still growing through deltas. */
  streaming: boolean;
  /**
   * A message Claude read later than it arrived: the ordinal of the item it is shown after
   * (docs/notes/orch-queued-placement.md); absent for every other item. Order by
   * stores/thread itemOrder, never by ordinal alone.
   */
  placedAfter?: number;
}

export interface TurnEndView {
  /** "success", "error_during_execution", ... */
  subtype: string;
  isError: boolean;
  interrupted: boolean;
  stopReason: string;
  terminalReason: string;
  durationMs: number;
  numTurns: number;
  /** Claude's cumulative estimate for the process, not this turn's. */
  costUsd: number;
  /** This turn's cost as the daemon measured it (it knows Claude's restarts); null when it could not tell, or from an older daemon. */
  turnCostUsd: number | null;
  /** The model of the turn's own replies as Claude names it ("claude-haiku-5-5"); "" when unknown. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  errors: readonly string[];
}

export interface ToolCallView {
  toolUseId: string;
  /** "Bash", "Read", "Edit", "Agent", "mcp__…", ... */
  name: string;
  /** The input as JSON; partial while streaming. */
  inputJson: string;
  status: ToolStatusView;
  /** The tool_result's text. */
  output: string;
  isError: boolean;
  /** The tool's structured result (tool_use_result) as JSON; "" when absent or too big. */
  resultJson: string;
}

/**
 * A wake message's origin: the daemon sent it because a subscription fired (a thread the
 * thread subscribed to settled, an action run finished). title is the header line without
 * its "[code-foundry wake] " prefix (`Thread "Fix the login" (s-…) is idle: finished.`);
 * json the payload Claude got in the fenced block (kind, subscription_id, condition,
 * fired_at, and the thread or the run).
 */
export interface WakeView {
  title: string;
  json: string;
}

/** One entry of a thread's conversation; the kind says which payload it has. */
export type ThreadItemView = ItemBase &
  (
    /**
     * composerText: the composer's text with its tag tokens ("" when sent without the composer); see lib/userMessage.
     * wake: set when the daemon sent it for a wake subscription (docs/notes/agents-4-wake.md), not the user.
     * resumeNote: the line Claude got before the text after something other than the user stopped its previous turn
     * (the budget stop, another thread's interrupt, an app restart; docs/notes/orch-child-context.md).
     * queued: set while Claude has not read it yet (sent while it worked; docs/notes/orch-queued-placement.md).
     */
    | { kind: "user"; text: string; attachments: readonly string[]; composerText: string; wake?: WakeView; resumeNote?: string; queued?: true }
    | { kind: "text"; text: string }
    | { kind: "thinking"; text: string }
    | ({ kind: "tool" } & ToolCallView)
    | { kind: "permission"; request: ThreadRequestView }
    | { kind: "question"; request: ThreadRequestView }
    | ({ kind: "turnEnd" } & TurnEndView)
    | { kind: "error"; text: string }
    | { kind: "compaction"; trigger: string; preTokens: number; postTokens: number; summary: string }
    | { kind: "commandOutput"; text: string }
    /**
     * A line the daemon adds, not Claude (a fork's "Forked from <parent>", where the copied
     * history ends). createdBy: the creator thread's id when it is the "Created by …" note
     * at the top of an agent-made thread (a fork's copy too), else "".
     */
    | { kind: "note"; text: string; createdBy: string }
    /**
     * An HTML page the model showed inline (code-foundry view.inline; docs/notes/inline-html.md):
     * path relative to baseDir (the thread's cwd when it was shown) or absolute; title as the
     * caller gave it, "" for none.
     */
    | { kind: "html"; path: string; title: string; baseDir: string }
  );

export type ThreadItemKind = ThreadItemView["kind"];

/** A request waiting on the user. */
export interface ThreadPendingView {
  requestId: string;
  /** The permission or question item. */
  itemId: string;
  question: boolean;
  toolName: string;
  /** One line: "Write hello.txt", or the question. */
  summary: string;
}

/** A thread's pending requests at seq. */
export interface ThreadPendingListView {
  threadId: string;
  seq: number;
  pending: readonly ThreadPendingView[];
}

export type ThreadEventView =
  | {
      kind: "snapshot";
      threadId: string;
      seq: number;
      items: ThreadItemView[];
      pending: ThreadPendingView[];
      mcp: McpStatusView | null;
      commands: SlashCommandView[];
      /** The thread's subagent runs in spawn order (docs/notes/agents-1-daemon.md). */
      agents: AgentRunView[];
    }
  | { kind: "appended" | "updated"; threadId: string; seq: number; item: ThreadItemView }
  | { kind: "delta"; threadId: string; seq: number; itemId: string; ordinal: number; field: "text" | "input"; text: string }
  | ({ kind: "pending" } & ThreadPendingListView)
  /** Watch only: the thread's MCP servers were checked again, or dropped (null: its process ended). */
  | { kind: "mcp"; threadId: string; seq: number; status: McpStatusView | null }
  /** Watch only: the thread's slash commands changed (the whole new list; empty: its process ended). */
  | { kind: "commands"; threadId: string; seq: number; commands: SlashCommandView[] }
  /** Watch only: the thread's subagent runs changed (the whole list, in spawn order). */
  | { kind: "agents"; threadId: string; seq: number; agents: AgentRunView[] }
  /** EventService only: the pending requests of every thread that has any. */
  | { kind: "pendingSnapshot"; threads: ThreadPendingListView[] };

const toolStatus: Record<ToolCallStatus, ToolStatusView> = {
  [ToolCallStatus.UNSPECIFIED]: "unknown",
  [ToolCallStatus.RUNNING]: "running",
  [ToolCallStatus.DONE]: "done",
  [ToolCallStatus.ERROR]: "error",
};

const requestState: Record<ThreadRequestState, RequestStateView> = {
  [ThreadRequestState.UNSPECIFIED]: "unknown",
  [ThreadRequestState.PENDING]: "pending",
  [ThreadRequestState.ALLOWED]: "allowed",
  [ThreadRequestState.DENIED]: "denied",
  [ThreadRequestState.CANCELLED]: "cancelled",
};

function toRequestView(r: ThreadRequestItem): ThreadRequestView {
  return {
    requestId: r.requestId,
    toolName: r.toolName,
    displayName: r.displayName,
    title: r.title,
    description: r.description,
    toolUseId: r.toolUseId,
    agentId: r.agentId,
    blockedPath: r.blockedPath,
    decisionReason: r.decisionReason,
    inputJson: r.inputJson,
    suggestionsJson: r.suggestionsJson,
    state: requestState[r.state],
    decision: r.decision,
    message: r.message,
    answers: { ...r.answers },
  };
}

/** The item as a view, or null for a payload this GUI does not know (a newer daemon's). */
export function toThreadItemView(it: ThreadItem): ThreadItemView | null {
  const base: ItemBase = {
    id: it.id,
    ordinal: Number(it.ordinal),
    parentToolUseId: it.parentToolUseId,
    createdAtMs: it.createdAt ? timestampMs(it.createdAt) : null,
    updatedAtMs: it.updatedAt ? timestampMs(it.updatedAt) : null,
    streaming: it.streaming,
    ...(it.placedAfter > 0n ? { placedAfter: Number(it.placedAfter) } : {}),
  };
  const p = it.payload;
  switch (p.case) {
    case "userMessage":
      return {
        ...base,
        kind: "user",
        text: p.value.text,
        attachments: [...p.value.attachments],
        composerText: p.value.composerText,
        ...(p.value.origin === MessageOrigin.WAKE ? { wake: { title: p.value.wakeTitle, json: p.value.wakeJson } } : {}),
        ...(p.value.resumeNote ? { resumeNote: p.value.resumeNote } : {}),
        ...(p.value.queued ? { queued: true as const } : {}),
      };
    case "assistantText":
      return { ...base, kind: "text", text: p.value.text };
    case "thinking":
      return { ...base, kind: "thinking", text: p.value.text };
    case "toolCall":
      return {
        ...base,
        kind: "tool",
        toolUseId: p.value.toolUseId,
        name: p.value.name,
        inputJson: p.value.inputJson,
        status: toolStatus[p.value.status],
        output: p.value.output,
        isError: p.value.isError,
        resultJson: p.value.resultJson,
      };
    case "permission":
      return { ...base, kind: "permission", request: toRequestView(p.value) };
    case "question":
      return { ...base, kind: "question", request: toRequestView(p.value) };
    case "turnEnd": {
      const t = p.value;
      return {
        ...base,
        kind: "turnEnd",
        subtype: t.subtype,
        isError: t.isError,
        interrupted: t.interrupted,
        stopReason: t.stopReason,
        terminalReason: t.terminalReason,
        durationMs: Number(t.durationMs),
        numTurns: t.numTurns,
        costUsd: t.costUsd,
        turnCostUsd: t.turnCostUsd ?? null,
        model: t.model,
        inputTokens: Number(t.inputTokens),
        outputTokens: Number(t.outputTokens),
        cacheReadTokens: Number(t.cacheReadTokens),
        cacheWriteTokens: Number(t.cacheWriteTokens),
        errors: [...t.errors],
      };
    }
    case "error":
      return { ...base, kind: "error", text: p.value.text };
    case "compaction":
      return { ...base, kind: "compaction", trigger: p.value.trigger, preTokens: Number(p.value.preTokens), postTokens: Number(p.value.postTokens), summary: p.value.summary };
    case "commandOutput":
      return { ...base, kind: "commandOutput", text: p.value.text };
    case "note":
      return { ...base, kind: "note", text: p.value.text, createdBy: p.value.createdBy };
    case "html":
      return { ...base, kind: "html", path: p.value.path, title: p.value.title, baseDir: p.value.baseDir };
    default:
      return null;
  }
}

function toPendingView(p: ThreadPendingRequest): ThreadPendingView {
  return { requestId: p.requestId, itemId: p.itemId, question: p.question, toolName: p.toolName, summary: p.summary };
}

function items(list: readonly ThreadItem[]): ThreadItemView[] {
  return list.flatMap((it) => {
    const v = toThreadItemView(it);
    return v ? [v] : [];
  });
}

export function toThreadEventView(ev: ThreadEvent): ThreadEventView | null {
  const e = ev.event;
  switch (e.case) {
    case "snapshot":
      return {
        kind: "snapshot",
        threadId: e.value.threadId,
        seq: Number(e.value.seq),
        items: items(e.value.items),
        pending: e.value.pending.map(toPendingView),
        mcp: toMcpStatusView(e.value.mcp),
        commands: toSlashCommandViews(e.value.commands),
        agents: toAgentRunViews(e.value.agents),
      };
    case "appended":
    case "updated": {
      const item = e.value.item ? toThreadItemView(e.value.item) : null;
      return item && { kind: e.case, threadId: e.value.threadId, seq: Number(e.value.seq), item };
    }
    case "delta": {
      const field = e.value.field === ThreadItemDelta_Field.TEXT ? "text" : e.value.field === ThreadItemDelta_Field.INPUT ? "input" : null;
      return field && { kind: "delta", threadId: e.value.threadId, seq: Number(e.value.seq), itemId: e.value.itemId, ordinal: Number(e.value.ordinal), field, text: e.value.text };
    }
    case "pending":
      return { kind: "pending", threadId: e.value.threadId, seq: Number(e.value.seq), pending: e.value.pending.map(toPendingView) };
    case "mcp":
      return { kind: "mcp", threadId: e.value.threadId, seq: Number(e.value.seq), status: toMcpStatusView(e.value.status) };
    case "commands":
      return { kind: "commands", threadId: e.value.threadId, seq: Number(e.value.seq), commands: toSlashCommandViews(e.value.commands) };
    case "agents":
      return { kind: "agents", threadId: e.value.threadId, seq: Number(e.value.seq), agents: toAgentRunViews(e.value.agents) };
    case "pendingSnapshot":
      return {
        kind: "pendingSnapshot",
        threads: e.value.threads.map((t) => ({ threadId: t.threadId, seq: Number(t.seq), pending: t.pending.map(toPendingView) })),
      };
    default:
      return null;
  }
}

/** Opens ThreadService.WatchThread for one thread and yields mapped events (a snapshot first) and HEARTBEAT for heartbeats. */
export async function* watchThread(threadId: string, signal: AbortSignal, conn: DaemonConnection = daemon): AsyncGenerator<ThreadEventView | Heartbeat> {
  const c = await conn.client(ThreadService);
  for await (const ev of c.watchThread({ threadId }, { signal })) {
    if (ev.event.case === "heartbeat") {
      yield HEARTBEAT;
      continue;
    }
    const v = toThreadEventView(ev);
    if (v) yield v;
  }
}
