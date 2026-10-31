/**
 * "Worktrees without threads" on a project's page (components/projects/LeftoverWorktrees,
 * docs/notes/projects-redesign-2-leftovers.md): which worktrees are leftovers, whether one
 * still holds work, and the plain-words sentence saying why it stayed. Pure; git facts come
 * from the daemon (status counts, landed, managed, the cleanup reason), never re-derived.
 */
import type { GitStatusView, WorktreeView } from "@/api/project";
import type { ThreadView } from "@/api/threads";
import { threadHolds, type CleanupThreads } from "./projects";

/**
 * A leftover: not the main worktree and no thread that is not archived has it as its cwd
 * or one of its checkouts (threadHolds, the daemon's cleanup guard). A terminal open in it
 * does not make it any less a leftover; the row says so.
 */
export function isLeftover(wt: Pick<WorktreeView, "path" | "isMain">, threads: CleanupThreads): boolean {
  return !wt.isMain && !threadHolds(threads, wt.path);
}

/** Staged, modified, untracked and conflicted entries: what removing the worktree loses. */
export function uncommittedCount(st: Pick<GitStatusView, "staged" | "modified" | "untracked" | "conflicted">): number {
  return st.staged + st.modified + st.untracked + (st.conflicted ?? 0);
}

/**
 * It still holds work (an amber dot, Show diff and Resume): uncommitted entries, or commits
 * whose work is not known to be in the default branch (landed false: commits ahead, no
 * remote default branch to compare with, or a failed status read). Clean means nothing
 * uncommitted and landed (a grey dot, New thread).
 */
export function holdsWork(wt: Pick<WorktreeView, "status" | "landed">): boolean {
  return uncommittedCount(wt.status) > 0 || wt.landed !== true;
}

export interface ArchivedThreads {
  order: readonly string[];
  byId: Readonly<Record<string, Pick<ThreadView, "id" | "archivedAtMs" | "worktreePath" | "checkoutPaths"> | undefined>>;
}

function inside(p: string, root: string): boolean {
  if (!p || !root) return false;
  return p === root || p.startsWith(root.endsWith("/") ? root : `${root}/`);
}

/** The most recently archived thread whose cwd or a checkout was the worktree (or inside it); null when none. */
export function lastArchivedOn(threads: ArchivedThreads, path: string): { id: string; archivedAtMs: number } | null {
  let best: { id: string; archivedAtMs: number } | null = null;
  for (const id of threads.order) {
    const t = threads.byId[id];
    if (t?.archivedAtMs == null) continue;
    if (!inside(t.worktreePath, path) && !t.checkoutPaths.some((c) => inside(c.path, path))) continue;
    if (best === null || t.archivedAtMs > best.archivedAtMs) best = { id: t.id, archivedAtMs: t.archivedAtMs };
  }
  return best;
}

/** "just now", "5m ago", "3h ago", "12d ago", "3w ago", "4mo ago", "2y ago" (the tables' compact ages). */
function agoText(ms: number, now: number): string {
  const m = Math.floor(Math.max(0, now - ms) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h ago`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${String(d)}d ago`;
  if (d < 60) return `${String(Math.floor(d / 7))}w ago`;
  if (d < 365) return `${String(Math.floor(d / 30))}mo ago`;
  return `${String(Math.floor(d / 365))}y ago`;
}

const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? "" : "s"}`;

export interface ReasonInput {
  /** The project's default branch, for "3 commits not on main" ("" falls back to the base ref without its remote). */
  defaultBranch: string;
  /** When the newest archived thread on it was archived; null when none was. */
  archivedAtMs: number | null;
  /** A terminal that has not exited is open in it. */
  terminal: boolean;
  now: number;
}

/**
 * Why the worktree stayed, in plain words, parts joined by " · ":
 * "made outside Code Foundry" (managed false), then the work ("3 commits not on main",
 * "4 uncommitted files", or "clean" when neither; "merged", or "merged otherwise" beside
 * uncommitted files, when its commits are in the default branch); a failed status read,
 * an operation in progress or a detached HEAD reads as the daemon's cleanup reason, and no
 * remote default branch says so; then "a terminal is open in it" and "last thread
 * archived 12d ago".
 */
export function leftoverReason(wt: Pick<WorktreeView, "status" | "detached" | "managed" | "landed" | "cleanupReason">, o: ReasonInput): string {
  const st = wt.status;
  const parts: string[] = [];
  if (wt.managed !== true) parts.push("made outside Code Foundry");
  const baseRef = st.baseRef ?? "";
  const ahead = st.baseAhead ?? 0;
  // An operation, a detached HEAD or a failed read: the daemon's cleanup reason names it
  // (it checks those before anything else), except for an unmanaged worktree, whose reason
  // is "not a Code Foundry worktree", said above.
  const stuck = st.error !== "" || (st.operation ?? "") !== "" || wt.detached;
  if (stuck) parts.push(wt.managed === true && wt.cleanupReason ? wt.cleanupReason : st.error ? "git status failed" : st.operation ? `${st.operation} in progress` : "detached HEAD");
  else if (!baseRef) parts.push("no remote default branch to compare with");
  const n = uncommittedCount(st);
  const unlanded = !stuck && baseRef !== "" && wt.landed !== true && ahead > 0;
  if (unlanded) {
    const base = o.defaultBranch || baseRef.replace(/^[^/]+\//, "");
    parts.push(`${plural(ahead, "commit")} not on ${base}`);
  }
  // "clean" only when nothing else is said about its work.
  if (n > 0) parts.push(plural(n, "uncommitted file"));
  else if (!unlanded) parts.push("clean");
  if (wt.landed === true) parts.push(n > 0 ? "merged otherwise" : "merged");
  if (o.terminal) parts.push("a terminal is open in it");
  if (o.archivedAtMs !== null) parts.push(`last thread archived ${agoText(o.archivedAtMs, o.now)}`);
  return parts.join(" · ");
}

/** The section header's bulk button: "Remove the 1 that is clean", "Remove the 3 that are clean". */
export function removeCleanLabel(n: number): string {
  return `Remove the ${String(n)} that ${n === 1 ? "is" : "are"} clean`;
}

/** The remove dialog's warning: "4 uncommitted files are lost." */
export function lossLine(n: number): string {
  return `${plural(n, "uncommitted file")} ${n === 1 ? "is" : "are"} lost.`;
}

/** The remove dialog's file list: the first three names, then "and N more" (null when nothing more). */
export function lossFiles(paths: readonly string[], total: number, shown = 3): { names: string; more: number } {
  const first = paths.slice(0, shown);
  return { names: first.join(", "), more: Math.max(0, total - first.length) };
}
