/**
 * Sidebar tree: repos -> worktrees -> sessions, then terminals, flattened into rows for a
 * virtual list. Pure functions over the minimal inputs that affect structure, so the
 * sidebar only rebuilds when membership or placement changes (not on title/state updates).
 */

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

export type Row =
  | { key: string; kind: "repo"; depth: 0; repoId: string; expanded: boolean; hasChildren: boolean }
  | { key: string; kind: "worktree"; depth: 1; repoId: string; path: string; expanded: boolean; hasChildren: boolean }
  | { key: string; kind: "group"; depth: 0; label: string; expanded: boolean; hasChildren: boolean }
  | { key: string; kind: "session"; depth: 1 | 2; sessionId: string }
  | { key: string; kind: "terminal"; depth: 1 | 2; terminalId: string };

/** Rows with no children of their own. */
export type LeafRow = Extract<Row, { kind: "session" | "terminal" }>;

export function isLeaf(row: Row): row is LeafRow {
  return row.kind === "session" || row.kind === "terminal";
}

export const OTHER_GROUP_KEY = "g:other";

export function repoKey(repoId: string): string {
  return `r:${repoId}`;
}
export function worktreeKey(repoId: string, path: string): string {
  return `w:${repoId}::${path}`;
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
export function ownedTerminalIds(sessions: readonly TreeSession[], terminals: readonly PlaceableTerminal[]): Set<string> {
  const ids = new Set(sessions.map((s) => s.id));
  const owned = new Set(sessions.map((s) => s.terminalId).filter(Boolean));
  for (const t of terminals) if (t.sessionLabel && ids.has(t.sessionLabel)) owned.add(t.id);
  return owned;
}

function push(map: Map<string, string[]>, k: string, v: string): void {
  const list = map.get(k);
  if (list) list.push(v);
  else map.set(k, [v]);
}

export function buildRows(
  repos: readonly TreeRepo[],
  terminals: readonly PlaceableTerminal[],
  collapsed: Readonly<Record<string, boolean>>,
  sessions: readonly TreeSession[] = [],
): Row[] {
  const worktrees: WorktreeRef[] = repos.flatMap((r) => r.worktreePaths.map((path) => ({ repoId: r.id, path })));
  const owned = ownedTerminalIds(sessions, terminals);
  const termsBy = new Map<string, string[]>();
  const sessionsBy = new Map<string, string[]>();
  const otherTerms: string[] = [];
  const otherSessions: string[] = [];
  for (const s of sessions) {
    const w = placeSession(s, worktrees);
    if (w) push(sessionsBy, worktreeKey(w.repoId, w.path), s.id);
    else otherSessions.push(s.id);
  }
  for (const t of terminals) {
    if (owned.has(t.id)) continue;
    const w = placeTerminal(t, worktrees);
    if (w) push(termsBy, worktreeKey(w.repoId, w.path), t.id);
    else otherTerms.push(t.id);
  }

  const rows: Row[] = [];
  for (const r of repos) {
    const rk = repoKey(r.id);
    const rExpanded = !collapsed[rk];
    rows.push({ key: rk, kind: "repo", depth: 0, repoId: r.id, expanded: rExpanded, hasChildren: r.worktreePaths.length > 0 });
    if (!rExpanded) continue;
    for (const path of r.worktreePaths) {
      const wk = worktreeKey(r.id, path);
      const sess = sessionsBy.get(wk) ?? [];
      const terms = termsBy.get(wk) ?? [];
      const wExpanded = !collapsed[wk];
      rows.push({ key: wk, kind: "worktree", depth: 1, repoId: r.id, path, expanded: wExpanded, hasChildren: sess.length + terms.length > 0 });
      if (!wExpanded) continue;
      for (const id of sess) rows.push({ key: sessionKey(id), kind: "session", depth: 2, sessionId: id });
      for (const id of terms) rows.push({ key: terminalKey(id), kind: "terminal", depth: 2, terminalId: id });
    }
  }
  if (otherSessions.length + otherTerms.length > 0) {
    const expanded = !collapsed[OTHER_GROUP_KEY];
    const label = otherSessions.length > 0 ? "Other" : "Other terminals";
    rows.push({ key: OTHER_GROUP_KEY, kind: "group", depth: 0, label, expanded, hasChildren: true });
    if (expanded) {
      for (const id of otherSessions) rows.push({ key: sessionKey(id), kind: "session", depth: 1, sessionId: id });
      for (const id of otherTerms) rows.push({ key: terminalKey(id), kind: "terminal", depth: 1, terminalId: id });
    }
  }
  return rows;
}

/** Leaf rows (sessions and terminals) in sidebar order regardless of collapse state (cmd+1..9). */
export function leafOrder(repos: readonly TreeRepo[], terminals: readonly PlaceableTerminal[], sessions: readonly TreeSession[] = []): LeafRow[] {
  return buildRows(repos, terminals, {}, sessions).filter(isLeaf);
}

/** Terminal ids in sidebar order regardless of collapse state. */
export function terminalOrder(repos: readonly TreeRepo[], terminals: readonly PlaceableTerminal[], sessions: readonly TreeSession[] = []): string[] {
  return leafOrder(repos, terminals, sessions).flatMap((r) => (r.kind === "terminal" ? [r.terminalId] : []));
}

/** Session ids in sidebar order regardless of collapse state. */
export function sessionOrder(repos: readonly TreeRepo[], terminals: readonly PlaceableTerminal[], sessions: readonly TreeSession[]): string[] {
  return leafOrder(repos, terminals, sessions).flatMap((r) => (r.kind === "session" ? [r.sessionId] : []));
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
