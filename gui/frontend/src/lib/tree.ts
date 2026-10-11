/**
 * Sidebar list: a flat list of threads (sessions), pinned ones first, then the ones waiting
 * on the user, then the rest, as rows for a virtual list. No repo, worktree or terminal
 * rows: worktrees live on the Projects page, and shells in their owner's bottom panel
 * (stores/bottomPanel.ts). Pure functions over the minimal inputs that affect structure, so
 * the sidebar only rebuilds when membership, order, pin or attention tier changes (not on
 * name/state updates). The placement helper (which worktree a thread sits in) is here too;
 * the command context uses it.
 */
import type { AttentionTier } from "./session";

export interface WorktreeRef {
  repoId: string;
  path: string;
}

export interface TreeRepo {
  id: string;
  worktreePaths: readonly string[];
}

/** One thread as the sidebar list needs it. */
export interface ListSession {
  id: string;
  pinned: boolean;
  /** Waits on the user ("prompt"), has an unseen finished turn ("done"), or neither (""); see attentionTier. */
  attention: AttentionTier;
}

/** The group a row sorts in. The groups follow each other without a header (data-section on the row says which). */
export type Section = "pinned" | "attention" | "threads";

export interface Row {
  key: string;
  kind: "session";
  section: Section;
  sessionId: string;
}

export function sessionKey(id: string): string {
  return `s:${id}`;
}

function trimSlash(p: string): string {
  return p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
}

/**
 * The worktree a thread sits in: the one whose path equals its worktree_path, else the
 * one whose path is the longest prefix of it (on a path-segment boundary). Null when
 * nothing matches.
 */
export function placeSession(s: { worktreePath: string }, worktrees: readonly WorktreeRef[]): WorktreeRef | null {
  const path = trimSlash(s.worktreePath);
  if (!path) return null;
  const exact = worktrees.find((w) => trimSlash(w.path) === path);
  if (exact) return exact;
  let best: WorktreeRef | null = null;
  let bestLen = -1;
  for (const w of worktrees) {
    const p = trimSlash(w.path);
    if (path.startsWith(p === "/" ? "/" : `${p}/`) && p.length > bestLen) {
      best = w;
      bestLen = p.length;
    }
  }
  return best;
}

/**
 * The sidebar rows. Threads newest first (`sessions` comes in creation order, the sessions
 * store's order) within each group: pinned ones (whatever their status), then unpinned ones
 * waiting on the user (prompts above finished turns), then the rest (error, interrupted and
 * offline threads included). No headers between them.
 */
export function buildRows(sessions: readonly ListSession[]): Row[] {
  const newest = [...sessions].reverse();
  const groups: [Section, ListSession[]][] = [
    ["pinned", newest.filter((s) => s.pinned)],
    ["attention", [...newest.filter((s) => !s.pinned && s.attention === "prompt"), ...newest.filter((s) => !s.pinned && s.attention === "done")]],
    ["threads", newest.filter((s) => !s.pinned && s.attention === "")],
  ];
  const rows: Row[] = [];
  for (const [section, list] of groups) for (const s of list) rows.push({ key: sessionKey(s.id), kind: "session", section, sessionId: s.id });
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
      return old?.section === r.section ? old : r;
    });
    prev = new Map(out.map((r) => [r.key, r]));
    return out;
  };
}

/** Thread ids in sidebar order (cmd+1..9, cmd+shift+a). */
export function sessionOrder(sessions: readonly ListSession[]): string[] {
  return buildRows(sessions).map((r) => r.sessionId);
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
