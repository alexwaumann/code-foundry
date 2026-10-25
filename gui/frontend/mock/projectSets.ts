/**
 * Workspaces v2 in the mock (docs/notes/workspaces-v2-3-composer.md): a thread's derived
 * checkouts and the collision hints thread.new / thread.new-like return as warnings
 * (CreateThreadResponse.hints), computed with the GUI's own rule (src/lib/collisionHints)
 * over the mock's threads and projects. The daemon labels the other thread "<name> (<id>)".
 */
import { collisionHints, threadCheckouts, type Checkout, type HintProjects, type HintThread } from "../src/lib/collisionHints";

/** The parts of a mock project the hints read. */
export interface SetProject {
  id: string;
  name: string;
  path: string;
  git?: boolean;
  worktrees: readonly { path: string; branch: string; head: string; isMain: boolean }[];
}

/** The parts of a mock thread the hints read; projectIds is the full set (World.projectIdsOf). */
export interface SetThread {
  id: string;
  name: string;
  projectId: string;
  projectIds: readonly string[];
  worktreePath: string;
  createdWorktree: boolean;
  branch: string;
  archivedAt: Date | null;
}

export function hintProjects(projects: Iterable<SetProject>): HintProjects {
  const out: Record<string, HintProjects[string]> = {};
  for (const p of projects) out[p.id] = { name: p.name, git: p.git !== false, path: p.path, worktrees: p.worktrees };
  return out;
}

function hintThread(t: SetThread, label: boolean): HintThread {
  return {
    id: t.id,
    name: label ? (t.name ? `${t.name} (${t.id})` : t.id) : t.name,
    projectId: t.projectId,
    projectIds: t.projectIds,
    worktreePath: t.worktreePath,
    createdWorktree: t.createdWorktree,
    branch: t.branch,
    archived: t.archivedAt !== null,
  };
}

/** A thread's checkouts as the daemon derives them (the GUI's rule; members it cannot place are left out). */
export function checkoutsOf(t: SetThread, projects: Iterable<SetProject>): Checkout[] {
  return threadCheckouts(hintThread(t, false), hintProjects(projects));
}

/** The daemon's CheckoutHints for a new thread: one line per checkout another thread that is not archived also has. */
export function createHints(t: SetThread, all: Iterable<SetThread>, projects: Iterable<SetProject>): string[] {
  const hp = hintProjects(projects);
  const mine = threadCheckouts(hintThread(t, false), hp);
  const others = [...all].map((x) => hintThread(x, true));
  return collisionHints({ checkouts: mine, worktreeMode: t.createdWorktree }, others, hp, t.id);
}
