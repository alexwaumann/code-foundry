/**
 * Sidebar list: a flat list of threads, pinned ones first (in creation order, newest
 * first), then the ones waiting on the user, then finished turns (both most recent status
 * change first), then idle ones (most recent activity first) (the main list); then the working ones
 * under a collapsible Working header, the snoozed ones under a collapsible Snoozed header
 * and the archived ones under a collapsible Archived header (the three footers,
 * buildSections), as rows for virtual lists. No project, worktree or terminal
 * rows: worktrees live on the Projects page, and shells in their owner's bottom panel
 * (stores/bottomPanel.ts). Pure functions over the minimal inputs that affect structure, so
 * the sidebar only rebuilds when membership, order, pin, group or a band's sort time changes
 * (not on name or status-text updates). The placement helper (which worktree a thread sits in) is here too;
 * the command context uses it.
 */
import type { ThreadGroup } from "./thread";

export interface WorktreeRef {
  projectId: string;
  path: string;
}

export interface TreeProject {
  id: string;
  worktreePaths: readonly string[];
}

/** One thread as the sidebar list needs it. */
export interface ListThread {
  id: string;
  pinned: boolean;
  /** Where it sorts when unpinned (lib/thread.ts threadGroup). */
  group: ThreadGroup;
  /** When the user archived it (epoch ms), null when not archived: it then sorts under Archived, whatever its pin and group. */
  archivedAtMs: number | null;
  /** When the snooze ends (epoch ms), null when not snoozed: it then sorts under Snoozed, whatever its pin and group. */
  snoozedUntilMs: number | null;
  /**
   * Hidden from the sidebar (lib/inSidebar.ts: a thread another thread created, while its
   * creator exists): in no panel, no count, no keyboard order. Absent: shown.
   */
  hidden?: boolean;
  /**
   * When its status last changed (epoch ms): the attention and done bands sort by it, most
   * recent first. Null or absent: unknown (it sorts after the known ones, newest created first).
   */
  statusChangedAtMs?: number | null;
  /** When it last did something (epoch ms): the idle band sorts by it, most recent first. Null or absent as for statusChangedAtMs. */
  lastActivityAtMs?: number | null;
}

/**
 * The sort times that matter for where a thread sits (buildSections): statusChangedAtMs
 * for an unpinned live thread in the attention or done band, lastActivityAtMs for one in
 * the idle band, both null otherwise (pinned, working, snoozed and archived threads sort by
 * other things). The sidebar's list keys (stores/context.ts) carry only these, so a working
 * thread's activity ticks do not rebuild the list.
 */
export function bandSortTimes(
  t: Pick<ListThread, "pinned" | "group" | "archivedAtMs" | "snoozedUntilMs" | "statusChangedAtMs" | "lastActivityAtMs">,
): { statusChangedAtMs: number | null; lastActivityAtMs: number | null } {
  const live = !t.pinned && t.archivedAtMs === null && t.snoozedUntilMs === null;
  const byStatus = live && (t.group === "prompt" || t.group === "error" || t.group === "done");
  return {
    statusChangedAtMs: byStatus ? (t.statusChangedAtMs ?? null) : null,
    lastActivityAtMs: live && t.group === "idle" ? (t.lastActivityAtMs ?? null) : null,
  };
}

/**
 * `list` (newest created first) sorted by `at`, most recent first; threads without a time
 * after those with one, in their order. Stable, so equal times keep newest created first.
 */
function byRecent(list: readonly ListThread[], at: (t: ListThread) => number | null | undefined): ListThread[] {
  const known = list.filter((t) => at(t) != null).sort((a, b) => (at(b) ?? 0) - (at(a) ?? 0));
  return [...known, ...list.filter((t) => at(t) == null)];
}

/**
 * The group a thread row sorts in. Only "working", "snoozed" and "archived" have a header
 * (they are the footers); the other groups follow each other without one (data-section on
 * the row says which a thread is in). "attention" holds prompts and then error /
 * interrupted threads; "done" unseen finished turns; "idle" everything else that is not
 * working; "snoozed" every snoozed thread and "archived" every archived one, whatever its
 * status or pin.
 */
export type Section = "pinned" | "attention" | "done" | "idle" | "working" | "snoozed" | "archived";

/** The sections with a header: the sidebar's three footers, in order. */
export type FooterSection = "working" | "snoozed" | "archived";

/** The footers in the order they stack under the main list. */
export const FOOTERS: readonly FooterSection[] = ["working", "snoozed", "archived"];

/**
 * How the list is shown (the UI store's sidebar prefs). Absent means expanded; the UI
 * store's defaults are Working expanded, Snoozed and Archived collapsed.
 */
export interface ListOptions {
  /** The Working section is collapsed: its header stays, its rows are not in the list. */
  workingCollapsed?: boolean;
  /** The Archived section is collapsed: its header stays, its rows are not in the list. */
  archivedCollapsed?: boolean;
  /** The Snoozed section is collapsed: its header stays, its rows are not in the list. */
  snoozedCollapsed?: boolean;
}

/** A footer's header (Working, Snoozed, Archived): a toggle, with the number of threads under it (shown or not). */
export type HeaderRow = {
  key: string;
  kind: "header";
  section: FooterSection;
  label: string;
  count: number;
  collapsed: boolean;
};

/** A thread row: the only rows that select something. */
export type ThreadRow = {
  key: string;
  kind: "thread";
  section: Section;
  threadId: string;
};

export type Row = HeaderRow | ThreadRow;

export function isThreadRow(row: Row): row is ThreadRow {
  return row.kind === "thread";
}

export function headerKey(section: Section): string {
  return `h:${section}`;
}

export function threadKey(id: string): string {
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
export function placeThread(s: { worktreePath: string }, worktrees: readonly WorktreeRef[]): WorktreeRef | null {
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
 * The sidebar's four panels: the main list (scrolls on its own) and the three footers pinned
 * below it, each footer its header row followed by its rows (none when collapsed); a
 * footer without threads is empty (no header).
 */
export interface Sections {
  main: Row[];
  working: Row[];
  snoozed: Row[];
  archived: Row[];
}

/**
 * The sidebar rows by panel (`threads` comes in creation order, the threads store's order).
 * Main, without headers: pinned ones (whatever their status), newest created first; then
 * unpinned ones waiting on the user (prompts, then error and interrupted threads, each most
 * recent statusChangedAtMs first); finished turns (most recent statusChangedAtMs first);
 * idle ones (idle, unknown; lib/thread threadGroup; most recent lastActivityAtMs first). In
 * a band, threads without the time sort after those with one, newest created first, as do
 * equal times. Working: the working ones (busy, starting, or waiting on child threads)
 * under a Working header that counts them, newest created first. Snoozed: every snoozed thread (pinned or not,
 * whatever its group; it appears nowhere else) under a Snoozed header, soonest wake first.
 * Archived: every archived thread (pinned or not, whatever its group; it appears nowhere
 * else; a thread is never both, but archived wins) under an Archived header, most recently
 * archived first. A footer has its header only when it has threads; collapsed, the header
 * alone. A hidden thread (ListThread.hidden) is in none of them and counts in no header.
 */
export function buildSections(threads: readonly ListThread[], opts: ListOptions = {}): Sections {
  const newest = threads.filter((s) => s.hidden !== true).reverse();
  const live = newest.filter((s) => s.archivedAtMs === null && s.snoozedUntilMs === null);
  const unpinned = (...groups: ThreadGroup[]) => groups.flatMap((g) => live.filter((s) => !s.pinned && s.group === g));
  const byStatus = (...groups: ThreadGroup[]) => groups.flatMap((g) => byRecent(unpinned(g), (s) => s.statusChangedAtMs));
  const rowsOf = (section: Section, list: readonly ListThread[]): Row[] => list.map((s) => ({ key: threadKey(s.id), kind: "thread", section, threadId: s.id }));
  const footer = (section: FooterSection, label: string, list: readonly ListThread[], collapsed: boolean): Row[] =>
    list.length === 0 ? [] : [{ key: headerKey(section), kind: "header", section, label, count: list.length, collapsed }, ...(collapsed ? [] : rowsOf(section, list))];
  // Stable sort: equal archive times keep newest-created first.
  const archived = newest.filter((s) => s.archivedAtMs !== null).sort((a, b) => (b.archivedAtMs ?? 0) - (a.archivedAtMs ?? 0));
  // Stable sort: equal wake times keep newest-created first.
  const snoozed = newest.filter((s) => s.archivedAtMs === null && s.snoozedUntilMs !== null).sort((a, b) => (a.snoozedUntilMs ?? 0) - (b.snoozedUntilMs ?? 0));
  return {
    main: [
      ...rowsOf("pinned", live.filter((s) => s.pinned)),
      ...rowsOf("attention", byStatus("prompt", "error")),
      ...rowsOf("done", byStatus("done")),
      ...rowsOf("idle", byRecent(unpinned("idle"), (s) => s.lastActivityAtMs)),
    ],
    working: footer("working", "Working", unpinned("working"), opts.workingCollapsed === true),
    snoozed: footer("snoozed", "Snoozed", snoozed, opts.snoozedCollapsed === true),
    archived: footer("archived", "Archived", archived, opts.archivedCollapsed === true),
  };
}

/** The sidebar rows in one order: the main list, then Working, Snoozed and Archived (buildSections). */
export function buildRows(threads: readonly ListThread[], opts: ListOptions = {}): Row[] {
  const sec = buildSections(threads, opts);
  return [...sec.main, ...FOOTERS.flatMap((f) => sec[f])];
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
export function threadOrder(threads: readonly ListThread[], opts: ListOptions = {}): string[] {
  return buildRows(threads, opts).flatMap((r) => (r.kind === "thread" ? [r.threadId] : []));
}

/**
 * The id `by` rows from `current` in `order`, wrapping at both ends (thread.previous and
 * thread.next, macOS tab switching). From an id not in the order (a page, a thread in a
 * collapsed section): the first row going down, the last going up. Null when empty.
 */
export function neighbourIn(order: readonly string[], current: string | null, by: 1 | -1): string | null {
  if (order.length === 0) return null;
  const at = current === null ? -1 : order.indexOf(current);
  if (at === -1) return (by === 1 ? order[0] : order[order.length - 1]) ?? null;
  return order[(at + by + order.length) % order.length] ?? null;
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
