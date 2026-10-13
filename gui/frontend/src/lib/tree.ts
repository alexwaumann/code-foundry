/**
 * Sidebar list: a flat list of threads (sessions), pinned ones first, then the ones waiting
 * on the user, then finished turns, then idle ones (the main list); then the working ones
 * under a collapsible Working header and the archived ones under a collapsible Archived
 * header (the two footers, buildSections), as rows for virtual lists. No repo, worktree or terminal
 * rows: worktrees live on the Projects page, and shells in their owner's bottom panel
 * (stores/bottomPanel.ts). Pure functions over the minimal inputs that affect structure, so
 * the sidebar only rebuilds when membership, order, pin or group changes (not on name or
 * status-text updates). The placement helper (which worktree a thread sits in) is here too;
 * the command context uses it.
 */
import type { ThreadGroup } from "./session";

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
  /** Where it sorts when unpinned (lib/session.ts threadGroup). */
  group: ThreadGroup;
  /** When the user archived it (epoch ms), null when not archived: it then sorts under Archived, whatever its pin and group. */
  archivedAtMs: number | null;
}

/**
 * The group a thread row sorts in. Only "working" and "archived" have a header (they are
 * the footers); the other groups follow each other without one (data-section on the row
 * says which a thread is in). "attention" holds prompts and then error / interrupted
 * threads; "done" unseen finished turns; "idle" everything else that is not working;
 * "archived" every archived thread, whatever its status or pin.
 */
export type Section = "pinned" | "attention" | "done" | "idle" | "working" | "archived";

/** The sections with a header: the sidebar's two footers. */
export type FooterSection = "working" | "archived";

/**
 * How the list is shown (the UI store's sidebar prefs). Absent means expanded; the UI
 * store's defaults are Working expanded, Archived collapsed.
 */
export interface ListOptions {
  /** The Working section is collapsed: its header stays, its rows are not in the list. */
  workingCollapsed?: boolean;
  /** The Archived section is collapsed: its header stays, its rows are not in the list. */
  archivedCollapsed?: boolean;
}

/** A footer's header (Working, Archived): a toggle, with the number of threads under it (shown or not). */
export type HeaderRow = {
  key: string;
  kind: "header";
  section: FooterSection;
  label: string;
  count: number;
  collapsed: boolean;
};

/** A thread row: the only rows that select something. */
export type SessionRow = {
  key: string;
  kind: "session";
  section: Section;
  sessionId: string;
};

export type Row = HeaderRow | SessionRow;

export function isSessionRow(row: Row): row is SessionRow {
  return row.kind === "session";
}

export function headerKey(section: Section): string {
  return `h:${section}`;
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
 * The sidebar's three panels: the main list (scrolls on its own) and the two footers pinned
 * below it, each footer its header row followed by its rows (none when collapsed); a
 * footer without threads is empty (no header).
 */
export interface Sections {
  main: Row[];
  working: Row[];
  archived: Row[];
}

/**
 * The sidebar rows by panel. Threads newest first (`sessions` comes in creation order, the
 * sessions store's order) within each group, so a thread moves only when it changes group.
 * Main: pinned ones (whatever their status); then unpinned ones waiting on the user
 * (prompts, then error and interrupted threads); finished turns; idle ones (idle, unknown,
 * closing, offline); all without headers. Working: the working ones (busy or starting)
 * under a Working header that counts them. Archived: every archived thread (pinned or not,
 * whatever its group; it appears nowhere else) under an Archived header, most recently
 * archived first. A footer has its header only when it has threads; collapsed, the header
 * alone.
 */
export function buildSections(sessions: readonly ListSession[], opts: ListOptions = {}): Sections {
  const newest = [...sessions].reverse();
  const live = newest.filter((s) => s.archivedAtMs === null);
  const unpinned = (...groups: ThreadGroup[]) => groups.flatMap((g) => live.filter((s) => !s.pinned && s.group === g));
  const rowsOf = (section: Section, list: readonly ListSession[]): Row[] => list.map((s) => ({ key: sessionKey(s.id), kind: "session", section, sessionId: s.id }));
  const footer = (section: FooterSection, label: string, list: readonly ListSession[], collapsed: boolean): Row[] =>
    list.length === 0 ? [] : [{ key: headerKey(section), kind: "header", section, label, count: list.length, collapsed }, ...(collapsed ? [] : rowsOf(section, list))];
  // Stable sort: equal archive times keep newest-created first.
  const archived = newest.filter((s) => s.archivedAtMs !== null).sort((a, b) => (b.archivedAtMs ?? 0) - (a.archivedAtMs ?? 0));
  return {
    main: [
      ...rowsOf("pinned", live.filter((s) => s.pinned)),
      ...rowsOf("attention", unpinned("prompt", "error")),
      ...rowsOf("done", unpinned("done")),
      ...rowsOf("idle", unpinned("idle")),
    ],
    working: footer("working", "Working", unpinned("working"), opts.workingCollapsed === true),
    archived: footer("archived", "Archived", archived, opts.archivedCollapsed === true),
  };
}

/** The sidebar rows in one order: the main list, then Working, then Archived (buildSections). */
export function buildRows(sessions: readonly ListSession[], opts: ListOptions = {}): Row[] {
  const { main, working, archived } = buildSections(sessions, opts);
  return [...main, ...working, ...archived];
}

/** Same row content: every field equal (rows are flat objects of strings, numbers and booleans). */
function sameRow(a: Row, b: Row): boolean {
  const ra: Record<string, unknown> = a;
  const rb: Record<string, unknown> = b;
  const keys = Object.keys(ra);
  return keys.length === Object.keys(rb).length && keys.every((k) => ra[k] === rb[k]);
}

/**
 * A row cache for the virtual list: each call returns `rows` with every row equal to the
 * previous call's row of the same key (same kind and section, and for a header the same
 * label, count and collapsed state) replaced by the previous object, so memoized row
 * components see the same prop and skip rendering.
 */
export function rowCache(): (rows: readonly Row[]) => Row[] {
  let prev = new Map<string, Row>();
  return (rows) => {
    const out = rows.map((r) => {
      const old = prev.get(r.key);
      return old && sameRow(old, r) ? old : r;
    });
    prev = new Map(out.map((r) => [r.key, r]));
    return out;
  };
}

/** Thread ids in sidebar order (cmd+1..9, cmd+shift+a); a collapsed section's threads are not in it. */
export function sessionOrder(sessions: readonly ListSession[], opts: ListOptions = {}): string[] {
  return buildRows(sessions, opts).flatMap((r) => (r.kind === "session" ? [r.sessionId] : []));
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
