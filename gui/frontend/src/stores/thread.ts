/**
 * Threads' items (docs/notes/rendered-threads-2-gui.md). One ThreadService.WatchThread per
 * visible thread view (the content pane's thread, and a plugin's thread node:
 * docs/notes/plugins-6-thread-terminal.md): a view of another thread opens its own, the
 * same thread shown twice shares one (startThreadWatch counts its holders). Each is a slot
 * in the connection budget (ARCHITECTURE §8), and it is what marks the thread's turns
 * seen. The Watch
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
import { resettleStreamSlots, type StreamPriority } from "@/api/streamSlots";
import type { AgentRunView } from "@/api/agents";
import type { McpStatusView } from "@/api/mcp";
import { shareCommands, type SlashCommandView } from "@/api/slashCommands";
import { watchThread, type ThreadEventView, type ThreadItemView, type ThreadPendingListView, type ThreadPendingView } from "@/api/thread";
import { shareAgents } from "@/lib/agents";
import { shareMcp } from "@/lib/mcp";
import { inlinePage } from "@/lib/inlinePage";
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
}

export interface ThreadState {
  logs: Readonly<Record<string, ThreadLog>>;
  /** Pending requests per thread from the EventService thread source (badges without a Watch). */
  pending: Readonly<Record<string, ThreadPendingListView>>;
  /** The open Watches, by thread (one per thread however many views show it). */
  watches: Readonly<Record<string, ThreadWatchState>>;
  /** Turns the user folded (true) or unfolded (false), by thread and turn key; absent: the default. */
  folds: Readonly<Record<string, Readonly<Record<string, boolean>>>>;
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

export const useThreadStore = create<ThreadState>()(() => ({ logs: {}, pending: {}, watches: {}, folds: {}, expanded: {}, deferred: {}, answering: {}, pageModals: {}, pageFlash: {} }));

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

/** A snapshot over the previous log, keeping unchanged items (and arrays) by identity. */
function replaceLog(
  prev: ThreadLog | undefined,
  seq: number,
  items: readonly ThreadItemView[],
  pending: readonly ThreadPendingView[],
  mcp: McpStatusView | null,
  commands: readonly SlashCommandView[],
  agents: readonly AgentRunView[],
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
  if (ev.kind === "snapshot") return replaceLog(log, ev.seq, ev.items, ev.pending, ev.mcp, ev.commands, ev.agents);
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
export function applyWatchBatch(threadId: string, events: readonly ThreadEventView[]): void {
  if (events.length === 0) return;
  useThreadStore.setState((s) => {
    const log = applyThreadEvents(s.logs[threadId], events);
    return log === s.logs[threadId] || !log ? s : { logs: { ...s.logs, [threadId]: log } };
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

function keepRecent(threadId: string): void {
  recentlyWatched = [threadId, ...recentlyWatched.filter((id) => id !== threadId)];
  const drop = new Set(recentlyWatched.slice(KEPT_LOGS).filter((id) => !openWatches.has(id)));
  recentlyWatched = recentlyWatched.filter((id) => !drop.has(id));
  if (drop.size > 0) pruneThreadLogs((id) => !drop.has(id));
}

/** The open Watches by thread: how many views hold each (and how many of them are core), and how to end it. */
const openWatches = new Map<string, { holders: number; core: number; stop: () => void }>();

/** How many Watches are open (one per thread on screen). */
export function openThreadWatches(): number {
  return openWatches.size;
}

/**
 * Holds the Watch of a thread a view shows, opening it for the first holder and keeping
 * it open (reconnecting with backoff) until the last one calls the returned function: one
 * stream per thread, however many views show it. Calling the release twice is harmless.
 * `priority` is the holder's stream priority (api/streamSlots.ts): a plugin's thread node
 * holds "inline"; the Watch is core while any core holder (the content pane) holds it.
 */
export function startThreadWatch(threadId: string, priority: StreamPriority = "core"): () => void {
  const core = priority === "core" ? 1 : 0;
  const held = openWatches.get(threadId);
  if (held) {
    held.holders++;
    held.core += core;
    // A core holder may lift a waiting inline Watch ahead of the queue.
    if (core) resettleStreamSlots();
  } else {
    const w: { holders: number; core: number; stop: () => void } = { holders: 1, core, stop: () => undefined };
    openWatches.set(threadId, w);
    w.stop = openThreadWatch(threadId, () => (w.core > 0 ? "core" : "inline"));
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const w = openWatches.get(threadId);
    if (!w) return;
    w.core -= core;
    if (--w.holders > 0) return;
    openWatches.delete(threadId);
    w.stop();
  };
}

/** Opens one thread's Watch; the returned function ends it. */
function openThreadWatch(threadId: string, priority: () => StreamPriority): () => void {
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
    slot: { label: `thread:${threadId}`, priority },
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
    open = false;
    stop();
    clearTimeout(timer);
    flush();
    useThreadStore.setState((s) => {
      if (!(threadId in s.watches)) return s;
      const { [threadId]: _gone, ...watches } = s.watches;
      return { watches };
    });
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

/** Expands (true) or collapses (false) a row of a thread. */
export function setRowExpanded(threadId: string, rowKey: string, expanded: boolean): void {
  useThreadStore.setState((s) => ({ expanded: { ...s.expanded, [threadId]: { ...s.expanded[threadId], [rowKey]: expanded } } }));
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
 * and its rows' expanded state go, so the next visit shows every finished turn folded.
 */
export function forgetTurnView(threadId: string): void {
  useThreadStore.setState((s) => {
    if (!(threadId in s.folds) && !(threadId in s.expanded) && !(threadId in s.deferred)) return s;
    const { [threadId]: _f, ...folds } = s.folds;
    const { [threadId]: _e, ...expanded } = s.expanded;
    const { [threadId]: _d, ...deferred } = s.deferred;
    return { folds, expanded, deferred };
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

function keyOf(it: ThreadItemView): string {
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

/** The thread's pending requests: the Watch's when it has the thread, else the EventService's. */
export function useThreadPending(threadId: string): readonly ThreadPendingView[] {
  return useThreadStore((s) => s.logs[threadId]?.pending ?? s.pending[threadId]?.pending ?? NO_PENDING);
}

/** The thread's pending requests without the ones being answered (their prompts left already). */
export function useOpenRequests(threadId: string): readonly ThreadPendingView[] {
  return useThreadStore(
    useShallow((s) => {
      const all = s.logs[threadId]?.pending ?? s.pending[threadId]?.pending ?? NO_PENDING;
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
    page: it.kind === "html" ? inlinePage(it).abs : "",
  };
}

/** A thread's items, read imperatively (copy actions). */
export function getThreadItems(threadId: string): ThreadItemView[] {
  const log = useThreadStore.getState().logs[threadId];
  return log ? log.order.flatMap((id) => (log.byId[id] ? [log.byId[id]] : [])) : [];
}
