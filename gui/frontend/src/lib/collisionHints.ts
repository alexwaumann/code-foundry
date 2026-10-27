/**
 * Collision hints (workspaces v2 handoff §4): before a thread starts, the members it
 * would share with another running thread (lib/thread isRunningThread). Hints, never blockers; the
 * daemon says the same after the Create (CreateThreadResponse.hints), over every thread
 * that is not archived. Pure, over the threads and projects the GUI knows. The composer
 * shows them as one banner (collisionBanner) and a line per project (collisionTip).
 *
 * Checkouts are derived the way the daemon does (docs/notes/workspaces-v2-1-threads.md):
 * the primary's is the thread's cwd; a plain folder is its folder; a worktree-mode git
 * member's is the worktree on the thread's branch (only when the project lists it: the
 * GUI does not compute the daemon's worktree path rule); otherwise the main checkout.
 */
import { WORKSPACE_PRIMARY } from "./projectSet";

export interface HintWorktree {
  path: string;
  branch: string;
  head: string;
  isMain: boolean;
}

export interface HintProject {
  name: string;
  /** false: a plain folder (one checkout, no branch). */
  git: boolean;
  path: string;
  worktrees: readonly HintWorktree[];
}

export type HintProjects = Readonly<Record<string, HintProject | undefined>>;

export interface HintThread {
  id: string;
  name: string;
  /** The primary; "" for one that runs in its workspace's folder (or without a project). */
  projectId: string;
  projectIds: readonly string[];
  worktreePath: string;
  createdWorktree: boolean;
  branch: string;
  archived: boolean;
  /** Claude is at work in it (lib/thread isWorkingThread); else it reads as idle. */
  working?: boolean;
}

export interface Checkout {
  projectId: string;
  path: string;
}

/** A project's own checkout: its main worktree, else its folder. */
export function mainCheckout(p: HintProject): string {
  return p.worktrees.find((w) => w.isMain)?.path ?? p.path;
}

/** The checkouts the GUI can tell a thread has (see the file comment); members it cannot place are left out. */
export function threadCheckouts(t: HintThread, projects: HintProjects): Checkout[] {
  const ids = t.projectIds.length > 0 ? t.projectIds : t.projectId ? [t.projectId] : [];
  const out: Checkout[] = [];
  for (const id of ids) {
    const p = projects[id];
    if (id === t.projectId && t.worktreePath) out.push({ projectId: id, path: t.worktreePath });
    else if (!p) continue;
    else if (!p.git) out.push({ projectId: id, path: mainCheckout(p) });
    else if (t.createdWorktree && t.branch) {
      const w = p.worktrees.find((x) => x.branch === t.branch);
      if (w) out.push({ projectId: id, path: w.path });
    } else out.push({ projectId: id, path: mainCheckout(p) });
  }
  return out;
}

/**
 * The checkouts a draft's thread would have that the GUI knows already: in place (not
 * worktree mode), every member's own checkout, the primary's at `primaryPath` when the
 * user picked a worktree; in worktree mode the plain folders, and with an existing
 * `branch` picked each git member's listed worktree on it (the daemon reuses it; a new
 * branch gets new worktrees). A primary of WORKSPACE_PRIMARY runs in the workspace's
 * folder, which no project owns.
 */
export function draftCheckouts(
  d: { projectIds: readonly string[]; primary: string; worktreeMode: boolean; primaryPath?: string; branch?: string },
  projects: HintProjects,
): Checkout[] {
  const out: Checkout[] = [];
  for (const id of d.projectIds) {
    const p = projects[id];
    if (!p) continue;
    if (!p.git) out.push({ projectId: id, path: mainCheckout(p) });
    else if (d.worktreeMode) {
      const w = d.branch ? p.worktrees.find((x) => x.branch === d.branch) : undefined;
      if (w) out.push({ projectId: id, path: w.path });
    }
    else if (id === d.primary && d.primary !== WORKSPACE_PRIMARY && d.primaryPath) out.push({ projectId: id, path: d.primaryPath });
    else out.push({ projectId: id, path: mainCheckout(p) });
  }
  return out;
}

/** The branch a checkout is on ("" for a plain folder, the short head when detached). */
function branchAt(p: HintProject | undefined, path: string): string {
  if (!p?.git) return "";
  const w = p.worktrees.find((x) => x.path === path);
  return w ? w.branch || w.head.slice(0, 7) : "";
}

function samePath(a: string, b: string): boolean {
  return a.replace(/\/+$/, "") === b.replace(/\/+$/, "");
}

/** A hint with the thread labels' " (<id>)" taken out: the daemon's "fix (s-12)" reads as the composer's "fix". */
function hintText(h: string): string {
  return h.replace(/ \([^\s()]+\)(?= also works there$|$)/, "");
}

/**
 * The daemon's after-create hints the composer did not already show under its chips
 * (`shown`, the composer's own lines), compared by text with the daemon's thread ids left
 * out. Each is said once, never as a toast after the same line in the composer.
 */
export function unshownHints(warnings: readonly string[], shown: readonly string[]): string[] {
  const seen = new Set(shown.map(hintText));
  return warnings.filter((w) => !seen.has(hintText(w)));
}

/** One project of a draft whose checkout another thread has (the first such thread). */
export interface Collision {
  projectId: string;
  /** The project's name (its id when unknown). */
  project: string;
  /** The checkout's branch ("" for a plain folder, the short head when detached). */
  branch: string;
  /** The other thread's name (its id when unnamed). */
  thread: string;
  working: boolean;
  /** A plain folder in a worktree-mode draft: fresh copies cannot set it apart. */
  folder: boolean;
}

/**
 * The checkouts of `mine` another thread that is not archived (and is not `self`) also
 * has, one per checkout; the first such thread names the collision. The caller passes
 * the threads that count (the composer: lib/thread isRunningThread).
 */
export function collisions(mine: { checkouts: readonly Checkout[]; worktreeMode: boolean }, threads: readonly HintThread[], projects: HintProjects, self = ""): Collision[] {
  const others = threads.filter((t) => t.id !== self && !t.archived).map((t) => ({ t, checkouts: threadCheckouts(t, projects) }));
  const out: Collision[] = [];
  for (const c of mine.checkouts) {
    const hit = others.find((o) => o.checkouts.some((x) => samePath(x.path, c.path)));
    if (!hit) continue;
    const p = projects[c.projectId];
    out.push({
      projectId: c.projectId,
      project: p?.name ?? c.projectId,
      branch: branchAt(p, c.path),
      thread: hit.t.name || hit.t.id,
      working: hit.t.working ?? false,
      folder: Boolean(p && !p.git && mine.worktreeMode),
    });
  }
  return out;
}

/**
 * A collision as the daemon words its hint: a plain folder in worktree mode "<name> is a
 * folder, not a repo: thread <other> also works there"; otherwise "<name> @ <branch> is
 * also open in <other>" (no "@ branch" for a folder). The composer hands these to
 * sendDraft, so the daemon's after-create toast does not say them again (unshownHints).
 */
export function hintLine(c: Collision): string {
  if (c.folder) return `${c.project} is a folder, not a repo: thread ${c.thread} also works there`;
  return `${c.branch ? `${c.project} @ ${c.branch}` : c.project} is also open in ${c.thread}`;
}

/** One line per checkout of `mine` another thread also has (collisions, worded by hintLine). */
export function collisionHints(mine: { checkouts: readonly Checkout[]; worktreeMode: boolean }, threads: readonly HintThread[], projects: HintProjects, self = ""): string[] {
  return collisions(mine, threads, projects, self).map(hintLine);
}

/** The composer banner's second, muted sentence. */
export const COLLISION_DETAIL = "Multiple agents changing the same file at the same time can overwrite each other's work.";

/**
 * The composer banner's first sentence, split around the branch the UI sets in mono:
 * `${lead}${branch}${tail}`, branch "" when none is named. A draft of several projects
 * (`setSize` > 1): "2 of 3 projects are already being edited on main by another running
 * thread."; of one: "This project is already being edited on main by another running
 * thread." Colliding projects on different branches read "on their branches"; with a
 * plain folder among them (no branch) the "on …" is left out.
 */
export function collisionBanner(list: readonly Collision[], setSize: number): { lead: string; branch: string; tail: string } {
  const count = new Set(list.map((c) => c.projectId)).size;
  const branches = new Set(list.map((c) => c.branch));
  const subject = setSize > 1 ? `${String(count)} of ${String(setSize)} projects ${count === 1 ? "is" : "are"}` : "This project is";
  const tail = " by another running thread.";
  const [only = ""] = branches;
  if (branches.size === 1 && only) return { lead: `${subject} already being edited on `, branch: only, tail };
  const theirs = branches.size > 1 && !branches.has("");
  return { lead: `${subject} already being edited${theirs ? " on their branches" : ""}`, branch: "", tail };
}

/** A collision's tooltip line: "<project> · <branch>" (the name alone for a folder) is open in <thread> (working | idle). */
export function collisionTip(c: Collision): { place: string; thread: string; status: "working" | "idle" } {
  return { place: c.branch ? `${c.project} · ${c.branch}` : c.project, thread: c.thread, status: c.working ? "working" : "idle" };
}
