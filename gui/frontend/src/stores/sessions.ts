import { create } from "zustand";
import type { SessionEventView, SessionView } from "@/api/session";

export interface SessionsData {
  byId: Readonly<Record<string, SessionView>>;
  /** Display order: creation time, then id. */
  order: readonly string[];
}

/**
 * Whether the daemon serves SessionService. "unavailable" (e.g. HTTP 404 from a daemon
 * without Phase 2a) leaves the rest of the UI working: session rows are simply absent and
 * session-labelled terminals show as plain terminals.
 */
export type SessionsAvailability = "unknown" | "available" | "unavailable";

interface SessionsState extends SessionsData {
  loaded: boolean;
  availability: SessionsAvailability;
  error: string | null;
}

export const emptySessions: SessionsData = { byId: {}, order: [] };

/** Structural equality, so unchanged sessions keep their identity and rows don't re-render. */
export function sameSession(a: SessionView, b: SessionView): boolean {
  return (Object.keys(a) as (keyof SessionView)[]).every((k) => (k === "linkedPullRequests" ? sameLinks(a[k], b[k]) : a[k] === b[k]));
}

/** Links only ever grow, in order, and a URL's entry never changes: compare URLs. */
function sameLinks(a: SessionView["linkedPullRequests"], b: SessionView["linkedPullRequests"]): boolean {
  return a === b || (a.length === b.length && a.every((l, i) => l.url === b[i]?.url));
}

function sortedOrder(byId: Readonly<Record<string, SessionView>>): string[] {
  return Object.values(byId)
    .sort((a, b) => (a.createdAtMs ?? 0) - (b.createdAtMs ?? 0) || a.id.localeCompare(b.id))
    .map((s) => s.id);
}

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/** Replaces the whole set (List result or snapshot), keeping identity for unchanged sessions. */
export function replaceSessions(prev: SessionsData, list: readonly SessionView[]): SessionsData {
  const byId: Record<string, SessionView> = {};
  for (const s of list) {
    const old = prev.byId[s.id];
    byId[s.id] = old && sameSession(old, s) ? old : s;
  }
  const order = sortedOrder(byId);
  const unchanged = sameOrder(order, prev.order) && order.every((id) => byId[id] === prev.byId[id]);
  return unchanged ? prev : { byId, order };
}

export function applySessionEvent(prev: SessionsData, ev: SessionEventView): SessionsData {
  switch (ev.kind) {
    case "snapshot":
      return replaceSessions(prev, ev.sessions);
    case "updated": {
      const s = ev.session;
      const old = prev.byId[s.id];
      if (old && sameSession(old, s)) return prev;
      const byId = { ...prev.byId, [s.id]: s };
      const order = old && old.createdAtMs === s.createdAtMs ? prev.order : sortedOrder(byId);
      return { byId, order };
    }
    case "removed": {
      if (!(ev.id in prev.byId)) return prev;
      const { [ev.id]: _removed, ...byId } = prev.byId;
      return { byId, order: prev.order.filter((id) => id !== ev.id) };
    }
  }
}

export const useSessionsStore = create<SessionsState>()(() => ({
  ...emptySessions,
  loaded: false,
  availability: "unknown",
  error: null,
}));

/** The session needs the user: needs-attention and not disconnected. */
export function isAttention(s: Pick<SessionView, "status" | "state">): boolean {
  return s.status === "attention" && s.state !== "disconnected";
}

/** Session ids that need the user, in `order`. */
export function attentionIds(data: SessionsData): string[] {
  return data.order.filter((id) => {
    const s = data.byId[id];
    return s !== undefined && isAttention(s);
  });
}

/** The session is working: busy and not disconnected. */
export function isRunning(s: Pick<SessionView, "status" | "state">): boolean {
  return s.status === "busy" && s.state !== "disconnected";
}

/** Sessions that are not disconnected (starting, connected, closing, unknown). */
export function connectedCount(data: SessionsData): number {
  let n = 0;
  for (const id of data.order) if (data.byId[id] && data.byId[id].state !== "disconnected") n++;
  return n;
}

/** Sessions that are running (isRunning). */
export function runningCount(data: SessionsData): number {
  let n = 0;
  for (const id of data.order) {
    const s = data.byId[id];
    if (s && isRunning(s)) n++;
  }
  return n;
}

/** The start page's thread list: sessions waiting on the user, then running ones, each in `order`. */
export function activeThreadIds(data: SessionsData): string[] {
  const running = data.order.filter((id) => {
    const s = data.byId[id];
    return s !== undefined && isRunning(s);
  });
  return [...attentionIds(data), ...running];
}

/** Number of sessions needing attention (a narrow, primitive selector). */
export function useAttentionCount(): number {
  return useSessionsStore((s) => attentionIds(s).length);
}

/**
 * The session a terminal belongs to, if that session is known. Terminals of known
 * sessions are shown through their session row, not as terminal rows.
 */
export function sessionOfTerminal(data: SessionsData, terminal: { id: string; labels: Readonly<Record<string, string>> }): SessionView | undefined {
  const labelled = terminal.labels.session;
  if (labelled && data.byId[labelled]) return data.byId[labelled];
  for (const id of data.order) {
    const s = data.byId[id];
    if (s?.terminalId === terminal.id) return s;
  }
  return undefined;
}
