/**
 * Sidebar list: a flat list of threads (sessions), pinned and needs-attention sections
 * on top, then terminals that belong to no thread, as rows for a virtual list. No repo or
 * worktree rows: worktrees live on the Projects page. Pure functions over the minimal
 * inputs that affect structure, so the sidebar only rebuilds when membership, order,
 * pin or attention changes (not on name/state updates). Placement helpers (which
 * worktree a terminal or thread sits in) are here too; the command context uses them.
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

/** One thread as the sidebar list needs it. */
export interface ListSession {
  id: string;
  /** Currently attached terminal, or "". */
  terminalId: string;
  pinned: boolean;
  /** Needs the user (connected and needs-attention). */
  attention: boolean;
}

export type Section = "pinned" | "attention" | "threads" | "terminals";

export type Row =
  | { key: string; kind: "header"; section: Section; label: string }
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

const sectionLabels: Record<Section, string> = {
  pinned: "Pinned",
  attention: "Needs attention",
  threads: "Threads",
  terminals: "Terminals",
};

/**
 * The sidebar rows. Threads newest first (`sessions` comes in creation order, the
 * sessions store's order): pinned ones under Pinned, unpinned ones that need the user
 * under Needs attention, the rest under Threads (that header only shows below another
 * section). Then terminals no thread owns, in `terminals` order, under Terminals.
 * Empty sections have no header.
 */
export function buildRows(sessions: readonly ListSession[], terminals: readonly PlaceableTerminal[]): Row[] {
  const owned = ownedTerminalIds(sessions, terminals);
  const newest = [...sessions].reverse();
  const pinned = newest.filter((s) => s.pinned);
  const attention = newest.filter((s) => !s.pinned && s.attention);
  const rest = newest.filter((s) => !s.pinned && !s.attention);
  const loose = terminals.filter((t) => !owned.has(t.id));
  const rows: Row[] = [];
  const header = (section: Section) => rows.push({ key: headerKey(section), kind: "header", section, label: sectionLabels[section] });
  const threads = (section: Exclude<Section, "terminals">, list: readonly ListSession[]) => {
    if (list.length === 0) return;
    if (section !== "threads" || rows.length > 0) header(section);
    for (const s of list) rows.push({ key: sessionKey(s.id), kind: "session", section, sessionId: s.id });
  };
  threads("pinned", pinned);
  threads("attention", attention);
  threads("threads", rest);
  if (loose.length > 0) {
    header("terminals");
    for (const t of loose) rows.push({ key: terminalKey(t.id), kind: "terminal", section: "terminals", terminalId: t.id });
  }
  return rows;
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
