/**
 * Threads' items (docs/notes/rendered-threads-2-gui.md). Only the visible
 * thread holds a ThreadService.Watch (the content pane's slot in the
 * connection budget, ARCHITECTURE §8, and it is what marks its turns seen). The Watch
 * sends a snapshot, then events with the thread's seq: an event whose seq is not above the
 * log's is dropped, and a later snapshot (a resync after drops, or a reconnect) replaces
 * the log. Items keep their identity while unchanged (structural equality), so a row only
 * re-renders for its own item. Events are applied in batches, at most one store update per
 * frame, so a fast stream of text deltas costs one render per frame.
 *
 * The EventService `thread` source feeds `pending` for every thread (its snapshot
 * is the pending requests of live threads); its item events are left to the Watch.
 */
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { invalidateOnTransportError } from "@/api/endpoint";
import { runStream, type StreamStatus } from "@/api/stream";
import type { McpStatusView } from "@/api/mcp";
import { shareCommands, type SlashCommandView } from "@/api/slashCommands";
import { watchThread, type ThreadEventView, type ThreadItemView, type ThreadPendingListView, type ThreadPendingView } from "@/api/thread";
import { shareMcp } from "@/lib/mcp";
import { timelineKey } from "@/lib/threadTimeline";

/** One thread's conversation as the Watch delivered it. */
export interface ThreadLog {
  /** The thread's event sequence number the log includes. */
  seq: number;
  byId: Readonly<Record<string, ThreadItemView>>;
  /** Item ids by ordinal. */
  order: readonly string[];
  pending: readonly ThreadPendingView[];
  /** The thread's MCP servers as last checked (docs/notes/mcp-panel.md); null: none. */
  mcp: McpStatusView | null;
  /**
   * The slash commands its running process offers (docs/notes/slash-commands-1-daemon.md),
   * in Claude's order; empty when it is not running (or the daemon predates the list).
   */
  commands: readonly SlashCommandView[];
}

export interface ThreadState {
  logs: Readonly<Record<string, ThreadLog>>;
  /** Pending requests per thread from the EventService thread source (badges without a Watch). */
  pending: Readonly<Record<string, ThreadPendingListView>>;
  /** The visible thread's Watch. */
  watch: { sessionId: string; status: StreamStatus; error: string | null } | null;
  /** Turns the user folded (true) or unfolded (false), by thread and turn key; absent: the default. */
  folds: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  /** Rows the user expanded (true) or collapsed (false), by thread and row key; absent: the row's default. */
  expanded: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  /**
   * Requests the user answered whose answer is on its way, by thread and request id: their
   * prompt leaves at once (threadActions respondThread) and comes back if the answer fails.
   */
  answering: Readonly<Record<string, Readonly<Record<string, true>>>>;
}

export const useThreadStore = create<ThreadState>()(() => ({ logs: {}, pending: {}, watch: null, folds: {}, expanded: {}, answering: {} }));

function sameArray<T>(a: readonly T[], b: readonly T[], eq: (x: T, y: T) => boolean = Object.is): boolean {
  return a === b || (a.length === b.length && a.every((x, i) => eq(x, b[i] as T)));
}

function sameAnswers(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/** Structural equality of two items (every field; arrays and the request by value). */
export function sameItem(a: ThreadItemView, b: ThreadItemView): boolean {
  if (a === b) return true;
  const ka = Object.keys(a);
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => {
    const x = (a as unknown as Record<string, unknown>)[k];
    const y = (b as unknown as Record<string, unknown>)[k];
    if (Array.isArray(x) && Array.isArray(y)) return sameArray(x, y);
    if (k === "request" && typeof x === "object" && typeof y === "object" && x && y) {
      const rx = x as Record<string, unknown>;
      const ry = y as Record<string, unknown>;
      return Object.keys(rx).every((f) => (f === "answers" ? sameAnswers(rx[f] as Record<string, string>, ry[f] as Record<string, string>) : rx[f] === ry[f]));
    }
    return x === y;
  });
}

function samePending(a: readonly ThreadPendingView[], b: readonly ThreadPendingView[]): boolean {
  return sameArray(a, b, (x, y) => x.requestId === y.requestId && x.itemId === y.itemId && x.question === y.question && x.toolName === y.toolName && x.summary === y.summary);
}

function byOrdinal(byId: Readonly<Record<string, ThreadItemView>>): string[] {
  return Object.values(byId)
    .sort((a, b) => a.ordinal - b.ordinal || a.id.localeCompare(b.id))
    .map((it) => it.id);
}

const NO_COMMANDS: readonly SlashCommandView[] = [];

/** A snapshot over the previous log, keeping unchanged items (and arrays) by identity. */
function replaceLog(
  prev: ThreadLog | undefined,
  seq: number,
  items: readonly ThreadItemView[],
  pending: readonly ThreadPendingView[],
  mcp: McpStatusView | null,
  commands: readonly SlashCommandView[],
): ThreadLog {
  const byId: Record<string, ThreadItemView> = {};
  for (const it of items) {
    const old = prev?.byId[it.id];
    byId[it.id] = old && sameItem(old, it) ? old : it;
  }
  const order = byOrdinal(byId);
  return {
    seq,
    byId,
    order: prev && sameArray(prev.order, order) ? prev.order : order,
    pending: prev && samePending(prev.pending, pending) ? prev.pending : pending,
    mcp: shareMcp(prev?.mcp ?? null, mcp),
    commands: shareCommands(prev?.commands ?? NO_COMMANDS, commands),
  };
}

/** Puts an item (new or replacing one with its id) into the log. */
function putItem(log: ThreadLog, it: ThreadItemView, seq: number): ThreadLog {
  const old = log.byId[it.id];
  if (old && sameItem(old, it)) return { ...log, seq };
  const byId = { ...log.byId, [it.id]: it };
  const order = old && old.ordinal === it.ordinal ? log.order : byOrdinal(byId);
  return { ...log, seq, byId, order };
}

/**
 * One event applied to a thread's log. Before the first snapshot there is no log and
 * every other event is dropped (the Watch always starts with one). An event with a seq
 * the log already includes is dropped; a delta for an unknown item only advances seq.
 */
export function applyThreadEvent(log: ThreadLog | undefined, ev: ThreadEventView): ThreadLog | undefined {
  if (ev.kind === "pendingSnapshot") return log;
  if (ev.kind === "snapshot") return replaceLog(log, ev.seq, ev.items, ev.pending, ev.mcp, ev.commands);
  if (!log || ev.seq <= log.seq) return log;
  switch (ev.kind) {
    case "appended":
    case "updated":
      return putItem(log, ev.item, ev.seq);
    case "delta": {
      const it = log.byId[ev.itemId];
      if (!it) return { ...log, seq: ev.seq };
      let next: ThreadItemView;
      if (ev.field === "input" && it.kind === "tool") next = { ...it, inputJson: it.inputJson + ev.text };
      else if (ev.field === "text" && (it.kind === "text" || it.kind === "thinking")) next = { ...it, text: it.text + ev.text };
      else return { ...log, seq: ev.seq };
      return { ...log, seq: ev.seq, byId: { ...log.byId, [it.id]: next } };
    }
    case "pending":
      return { ...log, seq: ev.seq, pending: samePending(log.pending, ev.pending) ? log.pending : ev.pending };
    case "mcp":
      return { ...log, seq: ev.seq, mcp: shareMcp(log.mcp, ev.status) };
    case "commands":
      return { ...log, seq: ev.seq, commands: shareCommands(log.commands, ev.commands) };
  }
}

/** The EventService thread source's pending requests after an event (item events change nothing). */
export function applyPendingEvent(prev: Readonly<Record<string, ThreadPendingListView>>, ev: ThreadEventView): Readonly<Record<string, ThreadPendingListView>> {
  switch (ev.kind) {
    case "pendingSnapshot": {
      const next: Record<string, ThreadPendingListView> = {};
      for (const t of ev.threads) {
        const old = prev[t.sessionId];
        next[t.sessionId] = old && old.seq === t.seq && samePending(old.pending, t.pending) ? old : t;
      }
      const keys = Object.keys(next);
      return keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]) ? prev : next;
    }
    case "pending": {
      const old = prev[ev.sessionId];
      if (old && ev.seq <= old.seq) return prev;
      if (ev.pending.length === 0) {
        if (!old) return prev;
        const { [ev.sessionId]: _gone, ...rest } = prev;
        return rest;
      }
      return { ...prev, [ev.sessionId]: { sessionId: ev.sessionId, seq: ev.seq, pending: ev.pending } };
    }
    default:
      return prev;
  }
}

/** EventService thread source handler (stores/events.ts). */
export function applyThreadSourceEvent(ev: ThreadEventView): void {
  useThreadStore.setState((s) => {
    const pending = applyPendingEvent(s.pending, ev);
    return pending === s.pending ? s : { pending };
  });
}

/**
 * A batch of events applied to a log (applyThreadEvent's rules). Text deltas, the bulk of
 * a stream, copy the item map once per batch rather than once per delta.
 */
export function applyThreadEvents(log: ThreadLog | undefined, events: readonly ThreadEventView[]): ThreadLog | undefined {
  /** The log this batch made (its byId is ours to write) or null. */
  let own: (ThreadLog & { byId: Record<string, ThreadItemView> }) | null = null;
  for (const ev of events) {
    if (ev.kind === "delta" && log && ev.seq > log.seq) {
      const it = log.byId[ev.itemId];
      const grown =
        it?.kind === "tool" && ev.field === "input"
          ? { ...it, inputJson: it.inputJson + ev.text }
          : (it?.kind === "text" || it?.kind === "thinking") && ev.field === "text"
            ? { ...it, text: it.text + ev.text }
            : null;
      if (own !== log) own = { ...log, byId: { ...log.byId } };
      if (grown) own.byId[grown.id] = grown;
      own.seq = ev.seq;
      log = own;
      continue;
    }
    log = applyThreadEvent(log, ev);
  }
  return log;
}

/** Applies a batch of Watch events to one thread's log in a single store update. */
export function applyWatchBatch(sessionId: string, events: readonly ThreadEventView[]): void {
  if (events.length === 0) return;
  useThreadStore.setState((s) => {
    const log = applyThreadEvents(s.logs[sessionId], events);
    return log === s.logs[sessionId] || !log ? s : { logs: { ...s.logs, [sessionId]: log } };
  });
}

/** How long Watch events wait to be applied together (about a frame). */
export const WATCH_BATCH_MS = 16;

/**
 * Logs kept for threads no longer watched, most recent first: switching back shows them at
 * once (the Watch's snapshot then replaces them). Older ones are dropped, so memory stays
 * bounded however many threads are opened (a log holds every item, tool output included).
 */
export const KEPT_LOGS = 4;
let recentlyWatched: string[] = [];

function keepRecent(sessionId: string): void {
  recentlyWatched = [sessionId, ...recentlyWatched.filter((id) => id !== sessionId)];
  const drop = new Set(recentlyWatched.slice(KEPT_LOGS));
  recentlyWatched = recentlyWatched.slice(0, KEPT_LOGS);
  if (drop.size > 0) pruneThreadLogs((id) => !drop.has(id));
}

/**
 * Opens the Watch for a thread (the visible thread; one at a time) and keeps it
 * open, reconnecting with backoff, until the returned function is called.
 */
export function startThreadWatch(sessionId: string): () => void {
  keepRecent(sessionId);
  let queue: ThreadEventView[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const batch = queue;
    queue = [];
    applyWatchBatch(sessionId, batch);
  };
  const setStatus = (status: StreamStatus, error: string | null) => {
    useThreadStore.setState((s) => (s.watch?.sessionId === sessionId || status === "connecting" ? { watch: { sessionId, status, error } } : s));
  };
  const stop = runStream<ThreadEventView>({
    open: (signal) => watchThread(sessionId, signal),
    // WKWebView can hold the tail of the stream after the window was hidden, minimized or
    // covered (docs/notes/thread-render-stall.md): a fresh Watch's snapshot catches up at
    // once on return, as leaving and reopening the thread does.
    resyncOnVisible: true,
    onEvent: (ev) => {
      queue.push(ev);
      timer ??= setTimeout(flush, WATCH_BATCH_MS);
    },
    onStatus: (status, err) => {
      setStatus(status, err ?? null);
    },
    onError: invalidateOnTransportError,
  });
  return () => {
    stop();
    clearTimeout(timer);
    flush();
    useThreadStore.setState((s) => (s.watch?.sessionId === sessionId ? { watch: null } : s));
  };
}

/** Forgets the logs of threads that are gone (sessions removed). */
export function pruneThreadLogs(keep: (sessionId: string) => boolean): void {
  useThreadStore.setState((s) => {
    const kept = Object.entries(s.logs).filter(([id]) => keep(id));
    return kept.length === Object.keys(s.logs).length ? s : { logs: Object.fromEntries(kept) };
  });
}

/** Folds (true) or unfolds (false) a turn of a thread. */
export function setTurnFolded(sessionId: string, turnKey: string, folded: boolean): void {
  useThreadStore.setState((s) => ({ folds: { ...s.folds, [sessionId]: { ...s.folds[sessionId], [turnKey]: folded } } }));
}

/** Expands (true) or collapses (false) a row of a thread. */
export function setRowExpanded(sessionId: string, rowKey: string, expanded: boolean): void {
  useThreadStore.setState((s) => ({ expanded: { ...s.expanded, [sessionId]: { ...s.expanded[sessionId], [rowKey]: expanded } } }));
}

const NO_FOLDS: Readonly<Record<string, boolean>> = {};
const NO_PENDING: readonly ThreadPendingView[] = [];

/** The user's fold choices for a thread's turns. */
export function useTurnFolds(sessionId: string): Readonly<Record<string, boolean>> {
  return useThreadStore((s) => s.folds[sessionId] ?? NO_FOLDS);
}

/** Whether a row is expanded: the user's choice, else `fallback`. */
export function useRowExpanded(sessionId: string, rowKey: string, fallback: boolean): boolean {
  return useThreadStore((s) => s.expanded[sessionId]?.[rowKey] ?? fallback);
}

/** One item (narrow: re-renders only when that item changes). */
export function useThreadItem(sessionId: string, id: string): ThreadItemView | undefined {
  return useThreadStore((s) => s.logs[sessionId]?.byId[id]);
}

/** Items keep their identity while unchanged, so each one's key is built once. */
const keyCache = new WeakMap<ThreadItemView, string>();

function keyOf(it: ThreadItemView): string {
  let k = keyCache.get(it);
  if (k === undefined) {
    k = timelineKey(structOf(it));
    keyCache.set(it, k);
  }
  return k;
}

/** The timeline's structural keys (lib/threadTimeline timelineKey): shallow-stable across text deltas. */
export function useTimelineKeys(sessionId: string): string[] {
  return useThreadStore(
    useShallow((s) => {
      const log = s.logs[sessionId];
      if (!log) return [];
      return log.order.flatMap((id) => {
        const it = log.byId[id];
        return it ? [keyOf(it)] : [];
      });
    }),
  );
}

/**
 * The input JSON of the Agent call a subagent's tool call (by tool_use id) runs under;
 * "" for the thread's own calls and calls not seen. A tool call's item id is its
 * tool_use id.
 */
export function useAgentInputOf(sessionId: string, toolUseId: string): string {
  return useThreadStore((s) => {
    const log = s.logs[sessionId];
    const call = toolUseId ? log?.byId[toolUseId] : undefined;
    const agent = call?.parentToolUseId ? log?.byId[call.parentToolUseId] : undefined;
    return agent?.kind === "tool" ? agent.inputJson : "";
  });
}

/** Whether the visible thread's snapshot arrived. */
export function useThreadLoaded(sessionId: string): boolean {
  return useThreadStore((s) => sessionId in s.logs);
}

/** The thread's log arrived and has no items (a thread started without a prompt, one still starting). */
export function useThreadEmpty(sessionId: string): boolean {
  return useThreadStore((s) => s.logs[sessionId]?.order.length === 0);
}

/**
 * The slash commands the thread's running process offers (narrow: the same list keeps its
 * identity); empty before its Watch's snapshot, when it is not running, or from a daemon
 * that predates the list.
 */
export function useSlashCommands(sessionId: string): readonly SlashCommandView[] {
  return useThreadStore((s) => s.logs[sessionId]?.commands ?? NO_COMMANDS);
}

/** The thread's pending requests: the Watch's when it has the thread, else the EventService's. */
export function useThreadPending(sessionId: string): readonly ThreadPendingView[] {
  return useThreadStore((s) => s.logs[sessionId]?.pending ?? s.pending[sessionId]?.pending ?? NO_PENDING);
}

/** The thread's pending requests without the ones being answered (their prompts left already). */
export function useOpenRequests(sessionId: string): readonly ThreadPendingView[] {
  return useThreadStore(
    useShallow((s) => {
      const all = s.logs[sessionId]?.pending ?? s.pending[sessionId]?.pending ?? NO_PENDING;
      const answering = s.answering[sessionId];
      return answering ? all.filter((p) => !answering[p.requestId]) : all;
    }),
  );
}

/** Marks a request answered (its prompt leaves) or, when its answer failed, open again. */
export function setAnswering(sessionId: string, requestId: string, on: boolean): void {
  useThreadStore.setState((s) => {
    const cur: Record<string, true> = Object.fromEntries(Object.entries(s.answering[sessionId] ?? {}).filter(([k]) => k !== requestId));
    if (on) cur[requestId] = true;
    return { answering: { ...s.answering, [sessionId]: cur } };
  });
}

/** What the timeline knows about an item. */
export function structOf(it: ThreadItemView): Parameters<typeof timelineKey>[0] {
  const req = it.kind === "permission" || it.kind === "question" ? it.request : null;
  return {
    id: it.id,
    kind: it.kind,
    name: it.kind === "tool" ? it.name : (req?.toolName ?? ""),
    parentToolUseId: it.parentToolUseId,
    toolUseId: it.kind === "tool" ? it.toolUseId : (req?.toolUseId ?? ""),
    toolStatus: it.kind === "tool" ? it.status : "",
    requestState: req?.state ?? "",
    streaming: it.streaming,
  };
}

/** A thread's items, read imperatively (copy actions). */
export function getThreadItems(sessionId: string): ThreadItemView[] {
  const log = useThreadStore.getState().logs[sessionId];
  return log ? log.order.flatMap((id) => (log.byId[id] ? [log.byId[id]] : [])) : [];
}
