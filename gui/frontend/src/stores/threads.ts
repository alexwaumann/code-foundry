import { create } from "zustand";
import type { AgentRunView, ThreadFlagView, ThreadListEventView, ThreadView, UsageBucketView } from "@/api/threads";
import { inSidebar } from "@/lib/inSidebar";
import { threadBadge } from "@/lib/thread";

export interface ThreadsData {
  /** Every thread, owned ones (a plugin's) included. */
  byId: Readonly<Record<string, ThreadView>>;
  /**
   * The user's threads in display order: creation time, then id. Owned threads (a
   * plugin's, ThreadView.owner, or a resident one, ThreadView.resident) are left out, so
   * nothing that lists the user's threads (the sidebar, attention counts and the dock, the
   * Threads panel, lineage, pickers) shows them: their plugin's thread node does
   * (docs/notes/plugins-6-thread-terminal.md); a resident's own row is the GUI's to add
   * (docs/notes/ember-1-primitives.md).
   */
  order: readonly string[];
  /** The owned threads, in the same order; absent when there are none. */
  owned?: readonly string[];
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

/**
 * Structural equality, so unchanged threads keep their identity and rows don't re-render.
 * Optional fields (owner, pluginEnvStale) count by presence too: one only b has is a change.
 */
export function sameThread(a: ThreadView, b: ThreadView): boolean {
  const keys = Object.keys(a) as (keyof ThreadView)[];
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => {
    switch (k) {
      case "linkedPullRequests":
        return sameLinks(a[k], b[k]);
      case "usage":
        return sameUsage(a[k], b[k]);
      case "agentRuns":
        return sameAgentRuns(a[k], b[k]);
      case "labels":
      case "projectIds":
        return a[k] === b[k] || (a[k].length === b[k].length && a[k].every((l, i) => l === b[k][i]));
      case "checkoutPaths":
        return a[k] === b[k] || (a[k].length === b[k].length && a[k].every((c, i) => sameCheckoutPath(c, b[k][i])));
      case "report":
        return sameReport(a[k], b[k]);
      case "flags":
        return sameFlags(a[k], b[k]);
      default:
        return a[k] === b[k];
    }
  });
}

/** A recorded checkout by value (every Updated event carries new objects). */
function sameCheckoutPath(a: ThreadView["checkoutPaths"][number], b: ThreadView["checkoutPaths"][number] | undefined): boolean {
  return b !== undefined && a.projectId === b.projectId && a.path === b.path;
}

/** Field-by-field equality of flags (every Updated event carries new objects). */
export function sameFlags(a: readonly ThreadFlagView[], b: readonly ThreadFlagView[]): boolean {
  return a === b || (a.length === b.length && a.every((x, i) => (Object.keys(x) as (keyof ThreadFlagView)[]).every((k) => x[k] === b[i]?.[k])));
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

/** Whether a thread is someone else's than the user's: a plugin's, or a resident one. */
export function isOwned(s: Pick<ThreadView, "owner" | "resident"> | undefined): boolean {
  return (s?.owner ?? "") !== "" || s?.resident !== undefined;
}

function sortedOrder(byId: Readonly<Record<string, ThreadView>>, owned = false): string[] {
  return Object.values(byId)
    .filter((s) => isOwned(s) === owned)
    .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0) || a.id.localeCompare(b.id))
    .map((s) => s.id);
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

const NO_OWNED: readonly string[] = [];

/**
 * The data with the owned list for byId, keeping prev's when unchanged. Always set (the
 * stores merge a result into their state, so an absent list would keep a stale one).
 */
function withOwned(data: ThreadsData, prev: ThreadsData): ThreadsData {
  const owned = sortedOrder(data.byId, true);
  if (owned.length === 0) return { ...data, owned: NO_OWNED };
  return { ...data, owned: prev.owned && sameOrder(prev.owned, owned) ? prev.owned : owned };
}

/** Replaces the whole set (List result or snapshot), keeping identity for unchanged threads. */
export function replaceThreads(prev: ThreadsData, list: readonly ThreadView[]): ThreadsData {
  const byId: Record<string, ThreadView> = {};
  for (const s of list) {
    const old = prev.byId[s.id];
    byId[s.id] = old && sameThread(old, s) ? old : s;
  }
  const order = sortedOrder(byId);
  const unchanged =
    Object.keys(byId).length === Object.keys(prev.byId).length && sameOrder(order, prev.order) && Object.keys(byId).every((id) => byId[id] === prev.byId[id]);
  return unchanged ? prev : withOwned({ byId, order }, prev);
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
      if (isOwned(s) || isOwned(old)) return withOwned({ byId, order: sortedOrder(byId) }, prev);
      const order = old && old.createdAtMs === s.createdAtMs ? prev.order : sortedOrder(byId);
      return { byId, order, owned: prev.owned ?? NO_OWNED };
    }
    case "removed": {
      if (!(ev.id in prev.byId)) return prev;
      const { [ev.id]: _removed, ...byId } = prev.byId;
      const order = prev.order.filter((id) => id !== ev.id);
      const owned = prev.owned?.filter((id) => id !== ev.id) ?? NO_OWNED;
      return { byId, order, owned: owned.length > 0 ? owned : NO_OWNED };
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
 * The thread needs the user: needs-attention, in any state, or a plugin's flag on it
 * (attention or error: a plugin raising one asks for the user like a prompt, so the
 * window title, the dock badge and alert follow; docs/notes/plugins-3-events-flags-env.md). The
 * daemon persists status, so a thread whose process stopped (or outlived a daemon restart)
 * while asking a question or waiting on a permission prompt still counts. "error"
 * (interrupted) does not.
 */
export function isAttention(s: Pick<ThreadView, "status" | "state"> & Partial<Pick<ThreadView, "flags">>): boolean {
  return s.status === "attention" || (s.flags?.length ?? 0) > 0;
}

/**
 * Thread ids that need the user, in `order`. An archived or snoozed thread never counts
 * (the window title, the dock badge, cmd+shift+a): archiving one
 * that was waiting (usually a finished turn) says the user is done with it, snoozing says
 * not until later, and it sits in a collapsed section. A snoozed thread counts again once
 * the daemon wakes it ("snooze ended" attention, snoozedUntilMs cleared). Neither does a
 * thread hidden from the sidebar (lib/inSidebar.ts, `showCreated` being
 * threads.show_created_threads): its creator answers it, not the user.
 */
export function attentionIds(data: ThreadsData, showCreated: boolean): string[] {
  return data.order.filter((id) => {
    const s = data.byId[id];
    return s !== undefined && s.archivedAtMs === null && s.snoozedUntilMs === null && inSidebar(s, showCreated) && isAttention(s);
  });
}

/**
 * The thread is working: the "busy" badge (busy, or Claude starting; threadBadge), never
 * a thread that needs attention.
 */
export function isRunning(s: Pick<ThreadView, "status" | "state"> & Partial<Pick<ThreadView, "flags">>): boolean {
  return !isAttention(s) && threadBadge(s) === "busy";
}

/** Threads that are running (isRunning), in `order`, hidden ones left out (attentionIds). */
function runningIds(data: ThreadsData, showCreated: boolean): string[] {
  return data.order.filter((id) => {
    const s = data.byId[id];
    return s !== undefined && inSidebar(s, showCreated) && isRunning(s);
  });
}

/** Threads that are running (isRunning), hidden ones left out. */
export function runningCount(data: ThreadsData, showCreated: boolean): number {
  return runningIds(data, showCreated).length;
}

/** Number of threads needing attention (a narrow, primitive selector); `showCreated` is useShowCreatedThreads. */
export function useAttentionCount(showCreated: boolean): number {
  return useThreadsStore((s) => attentionIds(s, showCreated).length);
}
