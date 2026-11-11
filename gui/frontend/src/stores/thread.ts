/**
 * Threads' items (docs/notes/rendered-threads-2-gui.md). One ThreadService.WatchThread per
 * visible thread view (the content pane's thread, and a plugin's thread node:
 * docs/notes/plugins-6-thread-terminal.md): a view of another thread opens its own, the
 * same thread shown twice shares one (startThreadWatch counts its holders). It is what
 * marks the thread's turns seen. The Watch
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
import type { AgentRunView } from "@/api/agents";
import type { WakeSubscriptionView } from "@/api/wakes";
import type { McpStatusView } from "@/api/mcp";
import { shareCommands, type SlashCommandView } from "@/api/slashCommands";
import { watchThread, type ThreadEventView, type ThreadItemView, type ThreadPendingListView, type ThreadPendingView } from "@/api/thread";
import { shareAgents } from "@/lib/agents";
import { shareWakes } from "@/lib/waitList";
import { shareMcp } from "@/lib/mcp";
import { inlinePage } from "@/lib/inlinePage";
import { NOTHING_SHOWN, type SetupShown } from "@/lib/threadSetup";
import { timelineKey } from "@/lib/threadTimeline";

/** One thread's conversation as the Watch delivered it. */
export interface ThreadLog {
  /** The thread's event sequence number the log includes. */
  seq: number;
  byId: Readonly<Record<string, ThreadItemView>>;
  /** Item ids in the log's order (itemOrder). */
  order: readonly string[];
  pending: readonly ThreadPendingView[];
  /** The thread's MCP servers as last checked (docs/notes/mcp-panel.md); null: none. */
  mcp: McpStatusView | null;
  /**
   * The slash commands its running process offers (docs/notes/slash-commands-1-daemon.md),
   * in Claude's order; empty when it is not running (or the daemon predates the list).
   */
  commands: readonly SlashCommandView[];
  /**
   * Its subagent runs in spawn order (docs/notes/agents-1-daemon.md), unchanged runs kept
   * by identity (lib/agents shareAgents); empty when it never ran one.
   */
  agents: readonly AgentRunView[];
  /** Its wake subscriptions (docs/notes/wait-list-daemon.md); an unchanged list keeps its identity. Absent: none. */
  wakes?: readonly WakeSubscriptionView[];
}

export interface ThreadState {
  logs: Readonly<Record<string, ThreadLog>>;
  /** Pending requests per thread from the EventService thread source (badges without a Watch). */
  pending: Readonly<Record<string, ThreadPendingListView>>;
  /** The open Watches, by thread (one per thread however many views show it). */
  watches: Readonly<Record<string, ThreadWatchState>>;
  /**
   * Threads whose open Watch has delivered a snapshot: their log is current. A log kept from
   * an earlier visit (KEPT_LOG_BUDGET) shows at once but may be behind until then.
   */
  synced: Readonly<Record<string, true>>;
  /** Turns the user folded (true) or unfolded (false), by thread and turn key; absent: the default. */
  folds: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  /** The lines a thread's setup row has shown while the thread was on screen, so a line once shown stays (lib/threadSetup setupView). */
  setupShown: Readonly<Record<string, SetupShown>>;
  /** Rows the user expanded (true) or collapsed (false), by thread and row key; absent: the row's default. */
  expanded: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
  /**
   * Finished turns left open because they ended while the timeline was scrolled up, by
   * thread and turn_end id (docs/notes/thread-fold-4-pinned-fold.md): they fold when the
   * list is pinned at the bottom again.
   */
  deferred: Readonly<Record<string, Readonly<Record<string, true>>>>;
  /**
   * Requests the user answered whose answer is on its way, by thread and request id: their
   * prompt leaves at once (threadActions respondThread) and comes back if the answer fails.
   * One goes once no pending list has it.
   */
  answering: Readonly<Record<string, Readonly<Record<string, true>>>>;
  /**
   * The page open in a pane's modal (an inline page's Expand; docs/notes/inline-page-shows.md),
   * by the pane's scope (PaneOverlay: the thread's id for its body, `<thread>/<run>` for a
   * subagent view). Not forgotten when the reader leaves the thread (forgetTurnView), so the
   * modal is up again on return; closing it, the thread going or being archived
   * (prunePageModals) and its item going (the modal closes itself) clear it. Session only.
   */
  pageModals: Readonly<Record<string, PageModalState>>;
  /**
   * The card an earlier show's link row last pointed at, by thread: its item id and when
   * (epoch ms). The card rings for a moment once it is on screen (PAGE_FLASH_MS).
   */
  pageFlash: Readonly<Record<string, { id: string; at: number }>>;
}

/** A pane's open page modal: the thread, the html item it shows, and whether it shows the source. */
export interface PageModalState {
  thread: string;
  id: string;
  source: boolean;
}

/** One thread's Watch: its stream's status, and the error it is retrying after. */
export interface ThreadWatchState {
  status: StreamStatus;
  error: string | null;
}

export const useThreadStore = create<ThreadState>()(() => ({ logs: {}, pending: {}, watches: {}, synced: {}, folds: {}, setupShown: {}, expanded: {}, deferred: {}, answering: {}, pageModals: {}, pageFlash: {} }));

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

/**
 * The log's order: by ordinal, except a message Claude read later than it arrived
 * (placedAfter) sits right after the item it was read after, behind messages placed there
 * earlier (docs/notes/orch-queued-placement.md).
 */
export function itemOrder(a: ThreadItemView, b: ThreadItemView): number {
  const pa = a.placedAfter ?? 0;
  const pb = b.placedAfter ?? 0;
  return (pa || a.ordinal) - (pb || b.ordinal) || Number(pa > 0) - Number(pb > 0) || a.ordinal - b.ordinal || a.id.localeCompare(b.id);
}

function byOrdinal(byId: Readonly<Record<string, ThreadItemView>>): string[] {
  return Object.values(byId)
    .sort(itemOrder)
    .map((it) => it.id);
}

const NO_COMMANDS: readonly SlashCommandView[] = [];
const NO_AGENTS: readonly AgentRunView[] = [];
const NO_WAKES: readonly WakeSubscriptionView[] = [];

/** A snapshot over the previous log, keeping unchanged items (and arrays) by identity. */
function replaceLog(
  prev: ThreadLog | undefined,
  seq: number,
  items: readonly ThreadItemView[],
  pending: readonly ThreadPendingView[],
  mcp: McpStatusView | null,
  commands: readonly SlashCommandView[],
  agents: readonly AgentRunView[],
  wakes: readonly WakeSubscriptionView[] = NO_WAKES,
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
    agents: shareAgents(prev?.agents ?? NO_AGENTS, agents),
    wakes: shareWakes(prev?.wakes ?? NO_WAKES, wakes),
  };
}

/** Puts an item (new or replacing one with its id) into the log. */
function putItem(log: ThreadLog, it: ThreadItemView, seq: number): ThreadLog {
  const old = log.byId[it.id];
  if (old && sameItem(old, it)) return { ...log, seq };
  const byId = { ...log.byId, [it.id]: it };
  const order = old && old.ordinal === it.ordinal && old.placedAfter === it.placedAfter ? log.order : byOrdinal(byId);
  return { ...log, seq, byId, order };
}

/**
 * One event applied to a thread's log. Before the first snapshot there is no log and
 * every other event is dropped (the Watch always starts with one). An event with a seq
 * the log already includes is dropped; a delta for an unknown item only advances seq.
 */
export function applyThreadEvent(log: ThreadLog | undefined, ev: ThreadEventView): ThreadLog | undefined {
  if (ev.kind === "pendingSnapshot") return log;
  if (ev.kind === "snapshot") return replaceLog(log, ev.seq, ev.items, ev.pending, ev.mcp, ev.commands, ev.agents, ev.wakes);
  if (ev.kind === "wakes") return log && { ...log, wakes: shareWakes(log.wakes ?? NO_WAKES, ev.wakes) }; // no seq: the list is whole, the last one wins
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
    case "agents":
      return { ...log, seq: ev.seq, agents: shareAgents(log.agents, ev.agents) };
  }
}

/** The EventService thread source's pending requests after an event (item events change nothing). */
export function applyPendingEvent(prev: Readonly<Record<string, ThreadPendingListView>>, ev: ThreadEventView): Readonly<Record<string, ThreadPendingListView>> {
  switch (ev.kind) {
    case "pendingSnapshot": {
      const next: Record<string, ThreadPendingListView> = {};
      for (const t of ev.threads) {
        const old = prev[t.threadId];
        next[t.threadId] = old && old.seq === t.seq && samePending(old.pending, t.pending) ? old : t;
      }
      const keys = Object.keys(next);
      return keys.length === Object.keys(prev).length && keys.every((k) => prev[k] === next[k]) ? prev : next;
    }
    case "pending": {
      const old = prev[ev.threadId];
      if (old && ev.seq <= old.seq) return prev;
      if (ev.pending.length === 0) {
        if (!old) return prev;
        const { [ev.threadId]: _gone, ...rest } = prev;
        return rest;
      }
      return { ...prev, [ev.threadId]: { threadId: ev.threadId, seq: ev.seq, pending: ev.pending } };
    }
    default:
      return prev;
  }
}

/**
 * `answering` without the thread's requests that no pending list has any more (their
 * answer landed); the same object when nothing went.
 */
function withoutAnswered(answering: ThreadState["answering"], threadId: string, ...lists: (readonly ThreadPendingView[] | undefined)[]): ThreadState["answering"] {
  const cur = answering[threadId];
  if (!cur) return answering;
  const ids = Object.keys(cur);
  const live = ids.filter((id) => lists.some((l) => l?.some((p) => p.requestId === id)));
  if (live.length === ids.length) return answering;
  const { [threadId]: _gone, ...rest } = answering;
  return live.length > 0 ? { ...rest, [threadId]: Object.fromEntries(live.map((id) => [id, true as const])) } : rest;
}

/** EventService thread source handler (stores/events.ts). */
export function applyThreadSourceEvent(ev: ThreadEventView): void {
  useThreadStore.setState((s) => {
    const pending = applyPendingEvent(s.pending, ev);
    if (pending === s.pending) return s;
    let answering = s.answering;
    for (const id of Object.keys(s.answering)) answering = withoutAnswered(answering, id, pending[id]?.pending, s.logs[id]?.pending);
    return answering === s.answering ? { pending } : { pending, answering };
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
export function applyWatchBatch(threadId: string, events: readonly ThreadEventView[]): void {
  if (events.length === 0) return;
  const snapshot = events.some((ev) => ev.kind === "snapshot");
  useThreadStore.setState((s) => {
    const log = applyThreadEvents(s.logs[threadId], events);
    const sync = snapshot && log && !s.synced[threadId] ? { synced: { ...s.synced, [threadId]: true as const } } : undefined;
    if (log === s.logs[threadId] || !log) return sync ?? s;
    const answering = withoutAnswered(s.answering, threadId, log.pending, s.pending[threadId]?.pending);
    return { logs: { ...s.logs, [threadId]: log }, ...sync, ...(answering !== s.answering ? { answering } : undefined) };
  });
}

/** Whether the thread's open Watch has delivered a snapshot (its log is current, not one kept from an earlier visit). */
export function useThreadSynced(threadId: string): boolean {
  return useThreadStore((s) => threadId in s.synced);
}

/** How long Watch events wait to be applied together (about a frame). */
export const WATCH_BATCH_MS = 16;

/**
 * How much text (in characters, about a byte each) the logs may hold together: an open
 * thread's counts, and logs of threads no longer watched fill the rest, most recent first.
 * Older ones are dropped, so memory stays bounded by what the logs hold, not by how many
 * there are (a thread can hold 50 KB or 50 MB; a Read's result holds a whole file). A kept
 * log only shows at once while the Watch fetches: its snapshot then replaces it, so nothing
 * here ever decides what is current (docs/notes/kept-logs-budget.md).
 */
export const KEPT_LOG_BUDGET = 64 * 1024 * 1024;
let recentlyWatched: string[] = [];

/** The characters of text in a value (an item's fields, a request's). */
function textSize(v: unknown): number {
  if (typeof v === "string") return v.length;
  if (typeof v !== "object" || v === null) return 0;
  return Object.values(v).reduce<number>((n, x) => n + textSize(x), 0);
}

/** A log no one updates keeps its identity, so each kept one is sized once. */
const logSizes = new WeakMap<ThreadLog, number>();

function logSize(log: ThreadLog): number {
  let n = logSizes.get(log);
  if (n === undefined) {
    n = textSize(log.byId);
    logSizes.set(log, n);
  }
  return n;
}

/**
 * The threads of `recent` (most recent first) whose logs fall outside the budget: those
 * past the point it runs out, except open ones, and the most recent closed one, which stays
 * however large it is (going back to the thread just left is the commonest switch).
 */
export function logsOverBudget(recent: readonly string[], size: (id: string) => number, open: (id: string) => boolean, budget = KEPT_LOG_BUDGET): string[] {
  let used = 0;
  let closed = 0;
  return recent.filter((id) => {
    used += size(id);
    if (open(id)) return false;
    closed++;
    return closed > 1 && used > budget;
  });
}

/** Drops the logs outside the budget, and the ids of threads with no log. */
function trimKeptLogs(): void {
  const { logs } = useThreadStore.getState();
  recentlyWatched = recentlyWatched.filter((id) => id in logs || openWatches.has(id));
  const size = (id: string) => {
    const log = logs[id];
    return log ? logSize(log) : 0;
  };
  const drop = new Set(logsOverBudget(recentlyWatched, size, (id) => openWatches.has(id)));
  if (drop.size === 0) return;
  recentlyWatched = recentlyWatched.filter((id) => !drop.has(id));
  pruneThreadLogs((id) => !drop.has(id));
}

function keepRecent(threadId: string): void {
  recentlyWatched = [threadId, ...recentlyWatched.filter((id) => id !== threadId)];
  trimKeptLogs();
}

/** The open Watches by thread: how many views hold each, and how to end it. */
const openWatches = new Map<string, { holders: number; stop: () => void }>();

/** How many Watches are open (one per thread on screen). */
export function openThreadWatches(): number {
  return openWatches.size;
}

/**
 * Holds the Watch of a thread a view shows, opening it for the first holder and keeping
 * it open (reconnecting with backoff) until the last one calls the returned function: one
 * stream per thread, however many views show it. Calling the release twice is harmless.
 */
export function startThreadWatch(threadId: string): () => void {
  const held = openWatches.get(threadId);
  if (held) {
    held.holders++;
  } else {
    const w = { holders: 1, stop: (): void => undefined };
    openWatches.set(threadId, w);
    w.stop = openThreadWatch(threadId);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const w = openWatches.get(threadId);
    if (!w) return;
    if (--w.holders > 0) return;
    openWatches.delete(threadId);
    w.stop();
  };
}

/** Opens one thread's Watch; the returned function ends it. */
function openThreadWatch(threadId: string): () => void {
  keepRecent(threadId);
  let queue: ThreadEventView[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = () => {
    timer = undefined;
    const batch = queue;
    queue = [];
    applyWatchBatch(threadId, batch);
  };
  let open = true;
  const setStatus = (status: StreamStatus, error: string | null) => {
    if (!open) return;
    useThreadStore.setState((s) => ({ watches: { ...s.watches, [threadId]: { status, error } } }));
  };
  const stop = runStream<ThreadEventView>({
    open: (signal) => watchThread(threadId, signal),
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
    open = false;
    stop();
    clearTimeout(timer);
    flush();
    useThreadStore.setState((s) => {
      if (!(threadId in s.watches) && !(threadId in s.synced)) return s;
      const { [threadId]: _gone, ...watches } = s.watches;
      const { [threadId]: _was, ...synced } = s.synced;
      return { watches, synced };
    });
    // Its log is final now: this is where a thread that grew counts.
    trimKeptLogs();
  };
}

/** A thread's Watch status ("idle" when none is open) and the error it retries after. */
export function useThreadWatch(threadId: string): { status: StreamStatus | "idle"; error: string | null } {
  const status = useThreadStore((s) => s.watches[threadId]?.status ?? "idle");
  const error = useThreadStore((s) => s.watches[threadId]?.error ?? null);
  return { status, error };
}

/** Forgets the logs of threads that are gone (threads removed). */
export function pruneThreadLogs(keep: (threadId: string) => boolean): void {
  useThreadStore.setState((s) => {
    const kept = Object.entries(s.logs).filter(([id]) => keep(id));
    return kept.length === Object.keys(s.logs).length ? s : { logs: Object.fromEntries(kept) };
  });
}

/** Folds (true) or unfolds (false) a turn of a thread. */
export function setTurnFolded(threadId: string, turnKey: string, folded: boolean): void {
  useThreadStore.setState((s) => ({ folds: { ...s.folds, [threadId]: { ...s.folds[threadId], [turnKey]: folded } } }));
}

/** Keeps the lines the setup's row shows of a thread; a line once shown stays. */
export function noteSetupShown(threadId: string, keys: readonly string[]): void {
  useThreadStore.setState((s) => {
    const was = s.setupShown[threadId] ?? NOTHING_SHOWN;
    if (keys.every((k) => was.has(k))) return s;
    return { setupShown: { ...s.setupShown, [threadId]: new Set([...was, ...keys]) } };
  });
}

/** What the setup's row has shown of a thread (narrow selector). */
export function useSetupShown(threadId: string): SetupShown {
  return useThreadStore((s) => s.setupShown[threadId] ?? NOTHING_SHOWN);
}

/** Expands (true) or collapses (false) a row of a thread. */
export function setRowExpanded(threadId: string, rowKey: string, expanded: boolean): void {
  useThreadStore.setState((s) => ({ expanded: { ...s.expanded, [threadId]: { ...s.expanded[threadId], [rowKey]: expanded } } }));
}

/** What marks a long user message's fold choice among a thread's expanded rows. */
const MESSAGE_FOLD = "msg:";

/**
 * A long user message's key among a thread's expanded rows (components/thread/MessageFold):
 * `id` is its item id, or a subagent prompt's own id. Unlike a row's expansion, the choice
 * outlives a visit to another thread (forgetTurnView).
 */
export function messageFoldKey(id: string): string {
  return `${MESSAGE_FOLD}${id}`;
}

/** A thread's fold and expand choices: the user's (and a reveal's), by turn key and row key. */
export interface TurnView {
  folds: Readonly<Record<string, boolean>>;
  expanded: Readonly<Record<string, boolean>>;
}

/** A thread's fold and expand choices as they are now (what a reveal compares against to put them back). */
export function getTurnView(threadId: string): TurnView {
  const s = useThreadStore.getState();
  return { folds: s.folds[threadId] ?? NO_FOLDS, expanded: s.expanded[threadId] ?? NO_EXPANDED };
}

/** Sets turn folds and row expansions of a thread; undefined drops the choice (the default again). */
export function putTurnView(threadId: string, folds: Readonly<Record<string, boolean | undefined>>, expanded: Readonly<Record<string, boolean | undefined>>): void {
  const merge = (cur: Readonly<Record<string, boolean>> | undefined, put: Readonly<Record<string, boolean | undefined>>) => {
    const out = new Map(Object.entries(cur ?? {}));
    for (const [k, v] of Object.entries(put)) {
      if (v === undefined) out.delete(k);
      else out.set(k, v);
    }
    return Object.fromEntries(out);
  };
  if (Object.keys(folds).length === 0 && Object.keys(expanded).length === 0) return;
  useThreadStore.setState((s) => ({
    folds: Object.keys(folds).length > 0 ? { ...s.folds, [threadId]: merge(s.folds[threadId], folds) } : s.folds,
    expanded: Object.keys(expanded).length > 0 ? { ...s.expanded, [threadId]: merge(s.expanded[threadId], expanded) } : s.expanded,
  }));
}

/** Leaves the turns that just ended (their turn_end ids) open: the timeline is scrolled up (TimelineOptions.deferred). */
export function deferTurnFolds(threadId: string, turnEndIds: readonly string[]): void {
  if (turnEndIds.length === 0) return;
  useThreadStore.setState((s) => {
    const cur: Record<string, true> = { ...s.deferred[threadId] };
    for (const id of turnEndIds) cur[id] = true;
    return { deferred: { ...s.deferred, [threadId]: cur } };
  });
}

/** The timeline is pinned at the bottom again: the turns left open fold (their default). No-op when there are none. */
export function foldDeferredTurns(threadId: string): void {
  useThreadStore.setState((s) => {
    if (!s.deferred[threadId]) return s;
    const { [threadId]: _gone, ...rest } = s.deferred;
    return { deferred: rest };
  });
}

/**
 * The user left the thread (its timeline unmounted): its turns left open, its fold choices
 * and its rows' expanded state go, so the next visit shows every finished turn folded. The
 * long messages they opened stay open (messageFoldKey): that is reading, not a view of the turn.
 */
export function forgetTurnView(threadId: string): void {
  useThreadStore.setState((s) => {
    if (!(threadId in s.folds) && !(threadId in s.expanded) && !(threadId in s.deferred) && !(threadId in s.setupShown)) return s;
    const { [threadId]: _f, ...folds } = s.folds;
    const { [threadId]: _s, ...setupShown } = s.setupShown;
    const { [threadId]: rows, ...expanded } = s.expanded;
    const { [threadId]: _d, ...deferred } = s.deferred;
    const messages = Object.entries(rows ?? {}).filter(([k]) => k.startsWith(MESSAGE_FOLD));
    return { folds, setupShown, expanded: messages.length > 0 ? { ...expanded, [threadId]: Object.fromEntries(messages) } : expanded, deferred };
  });
}

/** Opens a page in a pane's modal (the pane's scope; see ThreadState.pageModals). */
export function openPageModal(scope: string, threadId: string, itemId: string, source = false): void {
  useThreadStore.setState((s) => ({ pageModals: { ...s.pageModals, [scope]: { thread: threadId, id: itemId, source } } }));
}

/** Closes a pane's page modal. No-op when none is open. */
export function closePageModal(scope: string): void {
  useThreadStore.setState((s) => {
    if (!(scope in s.pageModals)) return s;
    const { [scope]: _gone, ...pageModals } = s.pageModals;
    return { pageModals };
  });
}

/** Shows the page (false) or its source (true) in a pane's open modal. */
export function setPageModalSource(scope: string, source: boolean): void {
  useThreadStore.setState((s) => {
    const cur = s.pageModals[scope];
    return !cur || cur.source === source ? s : { pageModals: { ...s.pageModals, [scope]: { ...cur, source } } };
  });
}

/** Closes the page modals of threads not kept (removed or archived threads). */
export function prunePageModals(keep: (threadId: string) => boolean): void {
  useThreadStore.setState((s) => {
    const kept = Object.entries(s.pageModals).filter(([, m]) => keep(m.thread));
    const flashes = Object.entries(s.pageFlash).filter(([id]) => keep(id));
    const same = kept.length === Object.keys(s.pageModals).length && flashes.length === Object.keys(s.pageFlash).length;
    return same ? s : { pageModals: Object.fromEntries(kept), pageFlash: Object.fromEntries(flashes) };
  });
}

/** A pane's open page modal; null when none. */
export function usePageModal(scope: string | null): PageModalState | null {
  return useThreadStore((s) => (scope === null ? null : (s.pageModals[scope] ?? null)));
}

/** The absolute path of the page open in a pane's modal; "" when none (or its item is not in the log). */
export function usePageModalPath(scope: string | null): string {
  return useThreadStore((s) => {
    const m = scope === null ? undefined : s.pageModals[scope];
    const it = m ? s.logs[m.thread]?.byId[m.id] : undefined;
    return it?.kind === "html" ? inlinePage(it).abs : "";
  });
}

/** How long (ms) a card a link row pointed at keeps its ring. */
export const PAGE_FLASH_MS = 1000;

/** Rings a page's card a moment (an earlier show's link row was clicked). */
export function flashPage(threadId: string, itemId: string, at = Date.now()): void {
  useThreadStore.setState((s) => ({ pageFlash: { ...s.pageFlash, [threadId]: { id: itemId, at } } }));
}

/** When the card of this item was last pointed at (epoch ms); 0 when it was not. */
export function usePageFlash(threadId: string, itemId: string): number {
  return useThreadStore((s) => {
    const f = s.pageFlash[threadId];
    return f?.id === itemId ? f.at : 0;
  });
}

/** The turn_end item ids of a log. */
function turnEndIds(log: ThreadLog): string[] {
  return log.order.filter((id) => log.byId[id]?.kind === "turnEnd");
}

/**
 * Calls `onEnd` with the turn_end ids that arrive in a thread's log from now on (a turn
 * ended), synchronously inside the store update that brings them, so before React renders
 * the rows they change: the timeline decides there whether the turn folds or stays open
 * (deferTurnFolds). The ends already in the log, and those in the log's first snapshot
 * when there was none yet (the thread opening), are not new. Returns the unsubscribe.
 */
export function watchTurnEnds(threadId: string, onEnd: (turnEndIds: string[]) => void): () => void {
  const first = useThreadStore.getState().logs[threadId];
  let order = first?.order;
  const seen = new Set(first ? turnEndIds(first) : []);
  return useThreadStore.subscribe((s) => {
    const log = s.logs[threadId];
    if (!log || log.order === order) return;
    const baseline = order === undefined;
    order = log.order;
    const fresh = turnEndIds(log).filter((id) => !seen.has(id));
    for (const id of fresh) seen.add(id);
    if (!baseline && fresh.length > 0) onEnd(fresh);
  });
}

const NO_FOLDS: Readonly<Record<string, boolean>> = {};
const NO_DEFERRED: Readonly<Record<string, true>> = {};
const NO_EXPANDED: Readonly<Record<string, boolean>> = {};
const NO_PENDING: readonly ThreadPendingView[] = [];

/** The user's fold choices for a thread's turns. */
export function useTurnFolds(threadId: string): Readonly<Record<string, boolean>> {
  return useThreadStore((s) => s.folds[threadId] ?? NO_FOLDS);
}

/** A thread's turns left open because they ended while its timeline was scrolled up, by turn_end id. */
export function useDeferredTurns(threadId: string): Readonly<Record<string, true>> {
  return useThreadStore((s) => s.deferred[threadId] ?? NO_DEFERRED);
}

/** Whether a row is expanded: the user's choice, else `fallback`. */
export function useRowExpanded(threadId: string, rowKey: string, fallback: boolean): boolean {
  return useThreadStore((s) => s.expanded[threadId]?.[rowKey] ?? fallback);
}

/** One item (narrow: re-renders only when that item changes). */
export function useThreadItem(threadId: string, id: string): ThreadItemView | undefined {
  return useThreadStore((s) => s.logs[threadId]?.byId[id]);
}

/** Items keep their identity while unchanged, so each one's key is built once. */
const keyCache = new WeakMap<ThreadItemView, string>();

/** An item's structural key (lib/threadTimeline timelineKey), cached per item. */
export function itemKeyOf(it: ThreadItemView): string {
  let k = keyCache.get(it);
  if (k === undefined) {
    k = timelineKey(structOf(it));
    keyCache.set(it, k);
  }
  return k;
}

/** The timeline's structural keys (lib/threadTimeline timelineKey): shallow-stable across text deltas. */
export function useTimelineKeys(threadId: string): string[] {
  return useThreadStore(
    useShallow((s) => {
      const log = s.logs[threadId];
      if (!log) return [];
      return log.order.flatMap((id) => {
        const it = log.byId[id];
        return it ? [itemKeyOf(it)] : [];
      });
    }),
  );
}

/**
 * The input JSON of the Agent call a subagent's tool call (by tool_use id) runs under;
 * "" for the thread's own calls and calls not seen. A tool call's item id is its
 * tool_use id.
 */
export function useAgentInputOf(threadId: string, toolUseId: string): string {
  return useThreadStore((s) => {
    const log = s.logs[threadId];
    const call = toolUseId ? log?.byId[toolUseId] : undefined;
    const agent = call?.parentToolUseId ? log?.byId[call.parentToolUseId] : undefined;
    return agent?.kind === "tool" ? agent.inputJson : "";
  });
}

/** Whether the visible thread's snapshot arrived. */
export function useThreadLoaded(threadId: string): boolean {
  return useThreadStore((s) => threadId in s.logs);
}

/** The thread's log arrived and has no items (a thread started without a prompt, one still starting). */
export function useThreadEmpty(threadId: string): boolean {
  return useThreadStore((s) => s.logs[threadId]?.order.length === 0);
}

/**
 * The slash commands the thread's running process offers (narrow: the same list keeps its
 * identity); empty before its Watch's snapshot, when it is not running, or from a daemon
 * that predates the list.
 */
export function useSlashCommands(threadId: string): readonly SlashCommandView[] {
  return useThreadStore((s) => s.logs[threadId]?.commands ?? NO_COMMANDS);
}

/**
 * The thread's pending requests: the Watch's once it has synced, else the EventService's.
 * A log kept from an earlier visit stopped following them when its Watch closed.
 */
function pendingOf(s: ThreadState, threadId: string): readonly ThreadPendingView[] {
  const log = s.logs[threadId];
  return (log && threadId in s.synced ? log.pending : s.pending[threadId]?.pending) ?? NO_PENDING;
}

/** The thread's pending requests (pendingOf). */
export function useThreadPending(threadId: string): readonly ThreadPendingView[] {
  return useThreadStore((s) => pendingOf(s, threadId));
}

/** The thread's pending requests without the ones being answered (their prompts left already). */
export function useOpenRequests(threadId: string): readonly ThreadPendingView[] {
  return useThreadStore(
    useShallow((s) => {
      const all = pendingOf(s, threadId);
      const answering = s.answering[threadId];
      return answering ? all.filter((p) => !answering[p.requestId]) : all;
    }),
  );
}

/** Marks a request answered (its prompt leaves) or, when its answer failed, open again. */
export function setAnswering(threadId: string, requestId: string, on: boolean): void {
  useThreadStore.setState((s) => {
    const cur: Record<string, true> = Object.fromEntries(Object.entries(s.answering[threadId] ?? {}).filter(([k]) => k !== requestId));
    if (on) cur[requestId] = true;
    return { answering: { ...s.answering, [threadId]: cur } };
  });
}

/**
 * What the timeline knows about an item. Claude Code's API-error text (apiError) is an
 * error there, not Claude's text: a red row that is no answer (no Copy answer, never a
 * final text, never Ember's reply) and stays when the turn folds.
 */
export function structOf(it: ThreadItemView): Parameters<typeof timelineKey>[0] {
  const req = it.kind === "permission" || it.kind === "question" ? it.request : null;
  return {
    id: it.id,
    kind: it.kind === "text" && it.apiError ? "error" : it.kind,
    name: it.kind === "tool" ? it.name : (req?.toolName ?? ""),
    parentToolUseId: it.parentToolUseId,
    toolUseId: it.kind === "tool" ? it.toolUseId : (req?.toolUseId ?? ""),
    toolStatus: it.kind === "tool" ? it.status : "",
    requestState: req?.state ?? "",
    streaming: it.streaming,
    page: it.kind === "html" ? inlinePage(it).abs : "",
  };
}

/** A thread's items, read imperatively (copy actions). */
export function getThreadItems(threadId: string): ThreadItemView[] {
  const log = useThreadStore.getState().logs[threadId];
  return log ? log.order.flatMap((id) => (log.byId[id] ? [log.byId[id]] : [])) : [];
}
