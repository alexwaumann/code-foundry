/**
 * Sidebar tree: repos -> worktrees -> terminals, flattened into rows for a virtual list.
 * Pure functions over the minimal inputs that affect structure, so the sidebar only
 * rebuilds when membership or placement changes (not on title/state updates).
 */

/** Label a terminal's creator sets to the worktree path it belongs to. */
export const WORKTREE_LABEL = "worktree";

export interface WorktreeRef {
  repoId: string;
  path: string;
}

export interface PlaceableTerminal {
  id: string;
  cwd: string;
  /** labels[WORKTREE_LABEL], or "" */
  worktreeLabel: string;
}

export interface TreeRepo {
  id: string;
  worktreePaths: readonly string[];
}

export type Row =
  | { key: string; kind: "repo"; depth: 0; repoId: string; expanded: boolean; hasChildren: boolean }
  | { key: string; kind: "worktree"; depth: 1; repoId: string; path: string; expanded: boolean; hasChildren: boolean }
  | { key: string; kind: "group"; depth: 0; label: string; expanded: boolean; hasChildren: boolean }
  | { key: string; kind: "terminal"; depth: 1 | 2; terminalId: string };

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

export function buildRows(
  repos: readonly TreeRepo[],
  terminals: readonly PlaceableTerminal[],
  collapsed: Readonly<Record<string, boolean>>,
): Row[] {
  const worktrees: WorktreeRef[] = repos.flatMap((r) => r.worktreePaths.map((path) => ({ repoId: r.id, path })));
  const byWorktree = new Map<string, string[]>();
  const other: string[] = [];
  for (const t of terminals) {
    const w = placeTerminal(t, worktrees);
    if (!w) {
      other.push(t.id);
      continue;
    }
    const k = worktreeKey(w.repoId, w.path);
    const list = byWorktree.get(k);
    if (list) list.push(t.id);
    else byWorktree.set(k, [t.id]);
  }

  const rows: Row[] = [];
  for (const r of repos) {
    const rk = repoKey(r.id);
    const rExpanded = !collapsed[rk];
    rows.push({ key: rk, kind: "repo", depth: 0, repoId: r.id, expanded: rExpanded, hasChildren: r.worktreePaths.length > 0 });
    if (!rExpanded) continue;
    for (const path of r.worktreePaths) {
      const wk = worktreeKey(r.id, path);
      const terms = byWorktree.get(wk) ?? [];
      const wExpanded = !collapsed[wk];
      rows.push({ key: wk, kind: "worktree", depth: 1, repoId: r.id, path, expanded: wExpanded, hasChildren: terms.length > 0 });
      if (!wExpanded) continue;
      for (const id of terms) rows.push({ key: terminalKey(id), kind: "terminal", depth: 2, terminalId: id });
    }
  }
  if (other.length > 0) {
    const expanded = !collapsed[OTHER_GROUP_KEY];
    rows.push({ key: OTHER_GROUP_KEY, kind: "group", depth: 0, label: "Other terminals", expanded, hasChildren: true });
    if (expanded) for (const id of other) rows.push({ key: terminalKey(id), kind: "terminal", depth: 1, terminalId: id });
  }
  return rows;
}

/** Terminal ids in sidebar order regardless of collapse state (for cmd+1..9). */
export function terminalOrder(repos: readonly TreeRepo[], terminals: readonly PlaceableTerminal[]): string[] {
  return buildRows(repos, terminals, {}).flatMap((r) => (r.kind === "terminal" ? [r.terminalId] : []));
}
