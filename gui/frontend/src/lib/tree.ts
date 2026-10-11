/**
 * Sidebar list: a flat list of threads (sessions), pinned ones first, then the ones waiting
 * on the user, then the rest, then terminals that belong to no thread under the one header
 * (Terminals), as rows for a virtual list. No repo or worktree rows: worktrees live on the
 * Projects page. Pure functions over the minimal inputs that affect structure, so the
 * sidebar only rebuilds when membership, order, pin or attention tier changes (not on
 * name/state updates). Placement helpers (which worktree a terminal or thread sits in) are
 * here too; the command context uses them.
 */
import type { AttentionTier } from "./session";


/** Label a terminal's creator sets to the worktree path it belongs to. */
export const WORKTREE_LABEL = "worktree";
/** Label the session store sets on a session's terminal: the session id. */
export const SESSION_LABEL = "session";

export interface WorktreeRef {
  repoId: string;
  path: string;
}

export interface PlaceableTerminal {
  id: string;
  cwd: string;
  /** labels[WORKTREE_LABEL], or "" */
  worktreeLabel: string;
  /** labels[SESSION_LABEL], or "" */
  sessionLabel?: string;
}

export interface TreeSession {
  id: string;
  worktreePath: string;
  /** Currently attached terminal, or "". */
  terminalId: string;
}

export interface TreeRepo {
  id: string;
  worktreePaths: readonly string[];
}

/** One thread as the sidebar list needs it. */
export interface ListSession {
  id: string;
  /** Currently attached terminal, or "". */
  terminalId: string;
  pinned: boolean;
  /** Waits on the user ("prompt"), has an unseen finished turn ("done"), or neither (""); see attentionTier. */
  attention: AttentionTier;
}

/**
 * The group a row sorts in. Only "terminals" has a header; the thread groups follow each
 * other without one (data-section on the row says which a thread is in).
 */
export type Section = "pinned" | "attention" | "threads" | "terminals";

export type Row =
  | { key: string; kind: "header"; section: "terminals"; label: string }
  | { key: string; kind: "session"; section: Exclude<Section, "terminals">; sessionId: string }
  | { key: string; kind: "terminal"; section: "terminals"; terminalId: string };

/** Rows that select something (threads and terminals); headers do not. */
export type LeafRow = Extract<Row, { kind: "session" | "terminal" }>;

export function isLeaf(row: Row): row is LeafRow {
  return row.kind === "session" || row.kind === "terminal";
}

export function headerKey(section: Section): string {
  return `h:${section}`;
}

export function terminalKey(id: string): string {
  return `t:${id}`;
}
export function sessionKey(id: string): string {
  return `s:${id}`;
}

function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * Finds the worktree a terminal belongs to: an exact `labels.worktree` match wins;
 * otherwise the worktree whose path is the longest prefix of the terminal's cwd (on
 * a path-segment boundary). Null when nothing matches.
 */
export function placeTerminal(t: Pick<PlaceableTerminal, "cwd" | "worktreeLabel">, worktrees: readonly WorktreeRef[]): WorktreeRef | null {
  const label = trimSlash(t.worktreeLabel);
  if (label) {
    const hit = worktrees.find((w) => trimSlash(w.path) === label);
    if (hit) return hit;
  }
  const cwd = trimSlash(t.cwd);
  if (!cwd) return null;
  let best: WorktreeRef | null = null;
  let bestLen = -1;
  for (const w of worktrees) {
    const p = trimSlash(w.path);
    if ((cwd === p || cwd.startsWith(p === "/" ? "/" : `${p}/`)) && p.length > bestLen) {
      best = w;
      bestLen = p.length;
    }
  }
  return best;
}

/** A session sits under the worktree equal to (or, failing that, containing) its worktree_path. */
export function placeSession(s: Pick<TreeSession, "worktreePath">, worktrees: readonly WorktreeRef[]): WorktreeRef | null {
  return placeTerminal({ cwd: s.worktreePath, worktreeLabel: s.worktreePath }, worktrees);
}

/** Terminals that belong to a known session are reached through the session row. */
export function ownedTerminalIds(sessions: readonly Pick<TreeSession, "id" | "terminalId">[], terminals: readonly PlaceableTerminal[]): Set<string> {
  const ids = new Set(sessions.map((s) => s.id));
  const owned = new Set(sessions.map((s) => s.terminalId).filter(Boolean));
  for (const t of terminals) if (t.sessionLabel && ids.has(t.sessionLabel)) owned.add(t.id);
  return owned;
}

/**
 * The sidebar rows. Threads newest first (`sessions` comes in creation order, the sessions
 * store's order) within each group: pinned ones (whatever their status), then unpinned ones
 * waiting on the user (prompts above finished turns), then the rest (error, interrupted and
 * offline threads included). No headers between them. Then terminals no thread owns, in
 * `terminals` order, under a Terminals header (only when there are any).
 */
export function buildRows(sessions: readonly ListSession[], terminals: readonly PlaceableTerminal[]): Row[] {
  const owned = ownedTerminalIds(sessions, terminals);
  const newest = [...sessions].reverse();
  const groups: [Exclude<Section, "terminals">, ListSession[]][] = [
    ["pinned", newest.filter((s) => s.pinned)],
    ["attention", [...newest.filter((s) => !s.pinned && s.attention === "prompt"), ...newest.filter((s) => !s.pinned && s.attention === "done")]],
    ["threads", newest.filter((s) => !s.pinned && s.attention === "")],
  ];
  const rows: Row[] = [];
  for (const [section, list] of groups) for (const s of list) rows.push({ key: sessionKey(s.id), kind: "session", section, sessionId: s.id });
  const loose = terminals.filter((t) => !owned.has(t.id));
  if (loose.length > 0) {
    rows.push({ key: headerKey("terminals"), kind: "header", section: "terminals", label: "Terminals" });
    for (const t of loose) rows.push({ key: terminalKey(t.id), kind: "terminal", section: "terminals", terminalId: t.id });
  }
  return rows;
}

/**
 * A row cache for the virtual list: each call returns `rows` with every row whose key and
 * section match the previous call's replaced by the previous object, so memoized row
 * components see the same prop and skip rendering.
 */
export function rowCache(): (rows: readonly Row[]) => Row[] {
  let prev = new Map<string, Row>();
  return (rows) => {
    const out = rows.map((r) => {
      const old = prev.get(r.key);
      return old?.kind === r.kind && old.section === r.section ? old : r;
    });
    prev = new Map(out.map((r) => [r.key, r]));
    return out;
  };
}

/** Thread and terminal rows in sidebar order (cmd+1..9). */
export function leafOrder(sessions: readonly ListSession[], terminals: readonly PlaceableTerminal[]): LeafRow[] {
  return buildRows(sessions, terminals).filter(isLeaf);
}

/** Session ids in sidebar order (cmd+shift+a). */
export function sessionOrder(sessions: readonly ListSession[], terminals: readonly PlaceableTerminal[]): string[] {
  return leafOrder(sessions, terminals).flatMap((r) => (r.kind === "session" ? [r.sessionId] : []));
}

/**
 * The next id in `order` after `current` that satisfies `pick`, wrapping around; the
 * first match when `current` is not in the list. Null when nothing matches.
 */
export function nextAfter(order: readonly string[], current: string | null, pick: (id: string) => boolean): string | null {
  const start = current === null ? -1 : order.indexOf(current);
  for (let i = 1; i <= order.length; i++) {
    const id = order[(start + i + order.length) % order.length];
    if (id !== undefined && pick(id)) return id;
  }
  return null;
}
