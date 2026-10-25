/**
 * Collision hints (workspaces v2 handoff §4): before a thread starts, the members it
 * would share with another thread that is not archived. Hints, never blockers; the
 * daemon says the same after the Create (CreateThreadResponse.hints). Pure, over the
 * threads and projects the GUI knows.
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
 * user picked a worktree; in worktree mode only the plain folders (git members get new
 * worktrees). A primary of WORKSPACE_PRIMARY runs in the workspace's folder, which no
 * project owns.
 */
export function draftCheckouts(d: { projectIds: readonly string[]; primary: string; worktreeMode: boolean; primaryPath?: string }, projects: HintProjects): Checkout[] {
  const out: Checkout[] = [];
  for (const id of d.projectIds) {
    const p = projects[id];
    if (!p) continue;
    if (!p.git) out.push({ projectId: id, path: mainCheckout(p) });
    else if (d.worktreeMode) continue;
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

/**
 * One line per checkout of `mine` another thread that is not archived (and is not
 * `self`) also has: in worktree mode a plain folder "<name> is a folder, not a repo:
 * thread <other> also works there"; otherwise "<name> @ <branch> is also open in <other>"
 * (no "@ branch" for a folder). The first such thread names the collision.
 */
export function collisionHints(mine: { checkouts: readonly Checkout[]; worktreeMode: boolean }, threads: readonly HintThread[], projects: HintProjects, self = ""): string[] {
  const others = threads.filter((t) => t.id !== self && !t.archived).map((t) => ({ t, checkouts: threadCheckouts(t, projects) }));
  const hints: string[] = [];
  for (const c of mine.checkouts) {
    const hit = others.find((o) => o.checkouts.some((x) => samePath(x.path, c.path)));
    if (!hit) continue;
    const p = projects[c.projectId];
    const name = p?.name ?? c.projectId;
    const other = hit.t.name || hit.t.id;
    if (p && !p.git && mine.worktreeMode) {
      hints.push(`${name} is a folder, not a repo: thread ${other} also works there`);
      continue;
    }
    const branch = branchAt(p, c.path);
    hints.push(`${branch ? `${name} @ ${branch}` : name} is also open in ${other}`);
  }
  return hints;
}
