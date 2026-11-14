/**
 * The shell's sidebar sections (docs/notes/shell-model.md, "Sidebar"; docs/notes/shell-16-sidebar.md):
 * Needs you, Active, then the Working, Snoozed and Archived footers as today (lib/tree.ts).
 *
 * - **Needs you** lists only actionable asks: the user's own threads (never a thread another
 *   thread created: those are `hidden`) blocked until the user acts (lib/thread.ts
 *   isActionableAsk: a permission, a question, a plan, a folder trust dialog), from every space or
 *   only the current one (the `sidebar.needs_scope` setting), most recent ask first. A thread
 *   listed there is not also listed under Active, whatever its pin. A thread that calls without
 *   blocking (ListThread.nudge: woken from a snooze, a notification or bell, an API error at the
 *   prompt, another attention reason, a plugin's flag) is never under Needs you and counts in
 *   none of its numbers (docs/notes/shell-25c-keys-drafts.md).
 * - **Active** lists the current space's live threads in today's order: pinned, then failed and
 *   interrupted ones, then finished turns, then idle ones. The space's composer drafts come right
 *   below the pinned threads, and the threads that call without blocking (unpinned) right below
 *   the drafts, most recent first. A thread of the space that waits on the user is never here:
 *   with either scope it is under Needs you.
 * - **Working** and **Snoozed** list the current space's threads; **Archived** every space's.
 *
 * Pure, over the same minimal inputs as lib/tree.ts plus each thread's space, so the sidebar
 * rebuilds only when membership or order changes.
 */
import { isSnoozed } from "./snooze";
import { buildSections, threadKey, type FooterSection, type ListOptions, type ListThread, type Row, type Section } from "./tree";

/** One thread as the shell's sidebar needs it: lib/tree's fields and the space it lives in. */
export interface ShellListThread extends ListThread {
  spaceId: string;
}

/** A composer draft of the current space, as the layout lists it (newest first). */
export interface ShellDraft {
  id: string;
  label: string;
}

/** Where the Needs you section looks: every space, or only the current one. */
export type NeedsScope = "all" | "space";

/** sidebar.needs_scope as a known value; anything else is the default, every space. */
export function needsScopeOf(v: string | undefined): NeedsScope {
  return v === "space" ? "space" : "all";
}

export interface ShellListOptions extends ListOptions {
  currentSpaceId: string;
  needsScope: NeedsScope;
  needsCollapsed?: boolean;
  activeCollapsed?: boolean;
  /** The current space's drafts, newest first. */
  drafts?: readonly ShellDraft[];
}

/** The two sections the shell adds; their headers sit inside the main list. */
export type MainSection = "needs" | "active";

/** Needs you's or Active's header: a toggle, with the number of rows under it (shown or not). */
export type MainHeaderRow = {
  key: string;
  kind: "header";
  section: MainSection;
  label: string;
  count: number;
  collapsed: boolean;
};

/** A thread row of the main list: under Needs you, or in one of Active's bands (lib/tree Section). */
export type ShellThreadRow = {
  key: string;
  kind: "thread";
  section: "needs" | Section;
  threadId: string;
};

/** A composer draft under Active. */
export type DraftRow = {
  key: string;
  kind: "draft";
  section: "active";
  draftId: string;
  label: string;
};

export type MainRow = MainHeaderRow | ShellThreadRow | DraftRow;

/** Any row of the shell's sidebar: the main list's, or a footer's (lib/tree Row). */
export type ShellRow = MainRow | Row;

export function draftKey(id: string): string {
  return `d:${id}`;
}

export function mainHeaderKey(section: MainSection): string {
  return `h:${section}`;
}

/** A row the cursor can land on and Enter opens: a thread or a draft. */
export function isPickable(row: ShellRow): row is ShellThreadRow | DraftRow {
  return row.kind === "thread" || row.kind === "draft";
}

export interface ShellSections {
  /** Needs you's header and rows, then Active's header, drafts and rows; [] for an empty section. */
  main: MainRow[];
  working: Row[];
  snoozed: Row[];
  archived: Row[];
}

/** Most recent first by `at`; threads without one after, in their order (lib/tree's byRecent). */
function byRecent<T extends ListThread>(list: readonly T[], at: (t: T) => number | null | undefined): T[] {
  const known = list.filter((t) => at(t) != null).sort((a, b) => (at(b) ?? 0) - (at(a) ?? 0));
  return [...known, ...list.filter((t) => at(t) == null)];
}

/** Whether a thread waits on the user with an actionable ask and would be listed under Needs you in some scope. */
function waitsOnUser(t: ListThread): boolean {
  return t.hidden !== true && t.archivedAtMs === null && !isSnoozed(t) && t.group === "prompt" && t.nudge !== true;
}

/** Whether a thread that calls without blocking sits at the top of Active: live, shown and unpinned (a pinned one stays with the pinned). */
function nudgeOnTop(t: ListThread): boolean {
  return t.nudge === true && t.hidden !== true && t.archivedAtMs === null && !isSnoozed(t) && !t.pinned;
}

/** Needs you's threads in its order (most recent ask first), in the scope in force, from those waiting on the user. */
function needsOf<T extends ShellListThread>(waiting: readonly T[], opts: Pick<ShellListOptions, "needsScope" | "currentSpaceId">): T[] {
  return byRecent([...waiting].reverse().filter((t) => opts.needsScope === "all" || t.spaceId === opts.currentSpaceId), (t) => t.statusChangedAtMs);
}

/**
 * The Needs you list (docs/notes/shell-17-needs-you.md): its thread ids in order, collapsed or
 * not, in the scope in force (the top bar's control and cmd+shift+a); `any` is whether some
 * thread in any space waits on the user (the section and the control show while one does).
 */
export function needsList(threads: readonly ShellListThread[], opts: Pick<ShellListOptions, "needsScope" | "currentSpaceId">): { ids: string[]; any: boolean } {
  const waiting = threads.filter(waitsOnUser);
  return { ids: needsOf(waiting, opts).map((t) => t.id), any: waiting.length > 0 };
}

/**
 * How many threads wait on the user in each space, by space id (no entry for none): the count a
 * space tab shows. The same threads Needs you lists for that space with "This space" in force
 * (needsList with `needsScope: "space"`), so the tab and the section never disagree: a finished
 * turn, a thread another thread started, an archived or snoozed one count in neither.
 */
export function needsBySpace(threads: readonly ShellListThread[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of threads) if (waitsOnUser(t)) out[t.spaceId] = (out[t.spaceId] ?? 0) + 1;
  return out;
}

/**
 * The shell sidebar's rows by panel (`threads` in creation order, the threads store's order).
 * Needs you has a header only while some thread in any space waits on the user, so its scope
 * button stays reachable when this space has none; Active has one while it has a row.
 */
export function buildShellSections(threads: readonly ShellListThread[], opts: ShellListOptions): ShellSections {
  const here = (t: ShellListThread) => t.spaceId === opts.currentSpaceId;
  const waiting = threads.filter(waitsOnUser);
  const needs = needsOf(waiting, opts);
  // The space's threads for Active, Working and Snoozed; those waiting on the user are Needs you's,
  // and those that call without blocking are placed below the drafts by hand.
  const nudges = byRecent(threads.filter((t) => here(t) && nudgeOnTop(t)).reverse(), (t) => t.statusChangedAtMs);
  const space = threads.filter(here).map((t) => (waitsOnUser(t) || nudgeOnTop(t) ? { ...t, hidden: true } : t));
  const local = buildSections(space, opts);
  const everywhere = buildSections(threads, { archivedCollapsed: opts.archivedCollapsed, openThreadId: opts.openThreadId });

  const main: MainRow[] = [];
  if (waiting.length > 0) {
    const collapsed = opts.needsCollapsed === true;
    main.push({ key: mainHeaderKey("needs"), kind: "header", section: "needs", label: "Needs you", count: needs.length, collapsed });
    if (!collapsed) for (const t of needs) main.push({ key: threadKey(t.id), kind: "thread", section: "needs", threadId: t.id });
  }
  const drafts: DraftRow[] = (opts.drafts ?? []).map((d) => ({ key: draftKey(d.id), kind: "draft", section: "active", draftId: d.id, label: d.label }));
  const pinned = local.main.filter((r) => r.kind === "thread" && r.section === "pinned");
  const rest = local.main.filter((r) => !(r.kind === "thread" && r.section === "pinned"));
  const nudged: ShellThreadRow[] = nudges.map((t) => ({ key: threadKey(t.id), kind: "thread", section: "attention", threadId: t.id }));
  const active: MainRow[] = [...pinned, ...drafts, ...nudged, ...rest].flatMap((r): MainRow[] => (r.kind === "header" ? [] : [r]));
  if (active.length > 0) {
    const collapsed = opts.activeCollapsed === true;
    main.push({ key: mainHeaderKey("active"), kind: "header", section: "active", label: "Active", count: active.length, collapsed });
    if (!collapsed) main.push(...active);
  }
  return { main, working: local.working, snoozed: local.snoozed, archived: everywhere.archived };
}

/** Every row in one order: the main list, then Working, Snoozed and Archived. */
export function shellRows(sec: ShellSections): ShellRow[] {
  const footers: FooterSection[] = ["working", "snoozed", "archived"];
  return [...sec.main, ...footers.flatMap((f) => sec[f])];
}

/** Thread ids in the shell sidebar's order, as on screen (cmd+1..9, thread.next and previous, cmd+shift+a). */
export function shellThreadOrder(threads: readonly ShellListThread[], opts: ShellListOptions): string[] {
  return shellRows(buildShellSections(threads, opts)).flatMap((r) => (r.kind === "thread" ? [r.threadId] : []));
}
