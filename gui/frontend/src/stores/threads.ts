import { create } from "zustand";
import type { AgentRunView, ThreadListEventView, ThreadView, UsageBucketView } from "@/api/threads";
import { threadBadge } from "@/lib/thread";

export interface ThreadsData {
  byId: Readonly<Record<string, ThreadView>>;
  /** Display order: creation time, then id. */
  order: readonly string[];
}

/**
 * Whether the daemon serves ThreadService. "unavailable" (e.g. HTTP 404 from a daemon
 * without Phase 2a) leaves the rest of the UI working: thread rows are simply absent.
 */
export type ThreadsAvailability = "unknown" | "available" | "unavailable";

interface ThreadsState extends ThreadsData {
  loaded: boolean;
  availability: ThreadsAvailability;
  error: string | null;
  /**
   * Usage of removed threads (the daemon's retired ledger). Usage over every thread is the
   * threads' usage plus this. From the snapshot and "retiredUsage" events.
   */
  retiredUsage: readonly UsageBucketView[];
  /**
   * Bumped whenever the whole set is replaced rather than changed: the List on each
   * events-stream (re)connect and every snapshot event. Whoever reacts to transitions
   * (stores/dockAlerts.ts) treats the set after a bump as a new baseline, since changes
   * missed while the events stream was down are not transitions the user just caused.
   */
  epoch: number;
}

export const emptyThreads: ThreadsData = { byId: {}, order: [] };

/** Structural equality, so unchanged threads keep their identity and rows don't re-render. */
export function sameThread(a: ThreadView, b: ThreadView): boolean {
  return (Object.keys(a) as (keyof ThreadView)[]).every((k) => {
    switch (k) {
      case "linkedPullRequests":
        return sameLinks(a[k], b[k]);
      case "usage":
        return sameUsage(a[k], b[k]);
      case "agentRuns":
        return sameAgentRuns(a[k], b[k]);
      case "labels":
        return a[k] === b[k] || (a[k].length === b[k].length && a[k].every((l, i) => l === b[k][i]));
      case "report":
        return sameReport(a[k], b[k]);
      default:
        return a[k] === b[k];
    }
  });
}

/** Field-by-field equality of reports (every Updated event carries a new object). */
function sameReport(a: ThreadView["report"], b: ThreadView["report"]): boolean {
  return a === b || (a !== null && b !== null && a.status === b.status && a.summary === b.summary && a.data === b.data && a.atMs === b.atMs);
}

/** Field-by-field equality of agent runs, their usage by sameUsage. */
export function sameAgentRuns(a: readonly AgentRunView[], b: readonly AgentRunView[]): boolean {
  return (
    a === b ||
    (a.length === b.length &&
      a.every((x, i) => {
        const y = b[i];
        return y !== undefined && (Object.keys(x) as (keyof AgentRunView)[]).every((k) => (k === "usage" ? sameUsage(x.usage, y.usage) : x[k] === y[k]));
      }))
  );
}

/** Field-by-field equality of usage buckets (every Updated event carries new arrays). */
export function sameUsage(a: readonly UsageBucketView[], b: readonly UsageBucketView[]): boolean {
  return a === b || (a.length === b.length && a.every((x, i) => (Object.keys(x) as (keyof UsageBucketView)[]).every((k) => x[k] === b[i]?.[k])));
}

/** The retired ledger after a thread event: kept by identity unless it changed. */
export function applyRetiredUsage(prev: readonly UsageBucketView[], ev: ThreadListEventView): readonly UsageBucketView[] {
  const next = ev.kind === "snapshot" ? ev.retiredUsage : ev.kind === "retiredUsage" ? ev.buckets : prev;
  return sameUsage(prev, next) ? prev : next;
}

/** Links only ever grow, in order, and a URL's entry never changes: compare URLs. */
function sameLinks(a: ThreadView["linkedPullRequests"], b: ThreadView["linkedPullRequests"]): boolean {
  return a === b || (a.length === b.length && a.every((l, i) => l.url === b[i]?.url));
}

function sortedOrder(byId: Readonly<Record<string, ThreadView>>): string[] {
  return Object.values(byId)
    .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0) || a.id.localeCompare(b.id))
    .map((s) => s.id);
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Replaces the whole set (List result or snapshot), keeping identity for unchanged threads. */
export function replaceThreads(prev: ThreadsData, list: readonly ThreadView[]): ThreadsData {
  const byId: Record<string, ThreadView> = {};
  for (const s of list) {
    const old = prev.byId[s.id];
    byId[s.id] = old && sameThread(old, s) ? old : s;
  }
  const order = sortedOrder(byId);
  const unchanged = sameOrder(order, prev.order) && order.every((id) => byId[id] === prev.byId[id]);
  return unchanged ? prev : { byId, order };
}

export function applyThreadListEvent(prev: ThreadsData, ev: ThreadListEventView): ThreadsData {
  switch (ev.kind) {
    case "snapshot":
      return replaceThreads(prev, ev.threads);
    case "updated": {
      const s = ev.thread;
      const old = prev.byId[s.id];
      if (old && sameThread(old, s)) return prev;
      const byId = { ...prev.byId, [s.id]: s };
      const order = old && old.createdAtMs === s.createdAtMs ? prev.order : sortedOrder(byId);
      return { byId, order };
    }
    case "removed": {
      if (!(ev.id in prev.byId)) return prev;
      const { [ev.id]: _removed, ...byId } = prev.byId;
      return { byId, order: prev.order.filter((id) => id !== ev.id) };
    }
    case "retiredUsage":
      return prev; // no thread changed: see applyRetiredUsage
  }
}

export const useThreadsStore = create<ThreadsState>()(() => ({
  ...emptyThreads,
  loaded: false,
  availability: "unknown",
  error: null,
  retiredUsage: [],
  epoch: 0,
}));

/**
 * The thread needs the user: needs-attention, in any state. The daemon persists status, so
 * a thread whose process stopped (or outlived a daemon restart) while asking a question or
 * waiting on a permission prompt still counts. "error" (interrupted) does not.
 */
export function isAttention(s: Pick<ThreadView, "status" | "state">): boolean {
  return s.status === "attention";
}

/**
 * Thread ids that need the user, in `order`. An archived or snoozed thread never counts
 * (the bell, the window title, the dock badge, cmd+shift+a, the start page): archiving one
 * that was waiting (usually a finished turn) says the user is done with it, snoozing says
 * not until later, and it sits in a collapsed section. A snoozed thread counts again once
 * the daemon wakes it ("snooze ended" attention, snoozedUntilMs cleared).
 */
export function attentionIds(data: ThreadsData): string[] {
  return data.order.filter((id) => {
    const s = data.byId[id];
    return s !== undefined && s.archivedAtMs === null && s.snoozedUntilMs === null && isAttention(s);
  });
}

/**
 * The thread is working: the "busy" badge (busy, or Claude starting; threadBadge), never
 * a thread that needs attention.
 */
export function isRunning(s: Pick<ThreadView, "status" | "state">): boolean {
  return !isAttention(s) && threadBadge(s) === "busy";
}

/** Threads that are running (isRunning), in `order`; none of them in attentionIds. */
function runningIds(data: ThreadsData): string[] {
  return data.order.filter((id) => {
    const s = data.byId[id];
    return s !== undefined && isRunning(s);
  });
}

/** Threads that are running (isRunning). */
export function runningCount(data: ThreadsData): number {
  return runningIds(data).length;
}

/**
 * The start page's thread list: threads waiting on the user, then running ones, each in
 * `order`. An id is never in both (attention wins): the list keys rows by id.
 */
export function activeThreadIds(data: ThreadsData): string[] {
  const waiting = attentionIds(data);
  const seen = new Set(waiting);
  return [...waiting, ...runningIds(data).filter((id) => !seen.has(id))];
}

/** Number of threads needing attention (a narrow, primitive selector). */
export function useAttentionCount(): number {
  return useThreadsStore((s) => attentionIds(s).length);
}
