/**
 * The Diff tab's Commits section (docs/notes/diff-commits.md): which commits it lists, what a
 * click sets and how it gets back. A commit is two real SHAs on the existing sides, not a mode:
 * the tab only remembers what it showed before, for All changes. Pure.
 */
import type { CompareCommitView, CompareSource } from "@/api/compare";
import { EMPTY_TREE, type DiffTarget } from "@/surfaces/diffTarget";

/** The most rows of the open list in the rail, and on top where the code needs the room. */
const RAIL_ROWS = 8;
const TOP_ROWS = 3;
/** The open list always shows at least this many. */
const MIN_ROWS = 2;

/** The section's folded height: its heading. */
export const COMMITS_HEADING_H = 32;
export const COMMIT_ROW_H = 30;

/**
 * Whether the tab shows Commits: only with nothing taken away. A thread that hid the compare
 * bar or the file list, or narrowed the list, fixed what the tab shows, and a commit would
 * change it. Show controls gives it back, as it does those.
 */
export function commitsShown(t: Pick<DiffTarget, "hide" | "paths">): boolean {
  return !t.hide?.length && !t.paths?.length;
}

/** The sides the list is of: those the tab had before a commit took them. */
export function listSides(t: Pick<DiffTarget, "base" | "head" | "commit">): { base: CompareSource; head: CompareSource } {
  return t.commit ? { base: t.commit.base, head: t.commit.head } : { base: t.base, head: t.head };
}

/** A commit's two sides: its first parent, or nothing for a root, and itself. */
export function commitSides(c: Pick<CompareCommitView, "sha" | "parent">): { base: CompareSource; head: CompareSource } {
  return { base: { kind: "ref", ref: c.parent || EMPTY_TREE }, head: { kind: "ref", ref: c.sha } };
}

/** What a click on a commit sets. The tab's first view is kept across a move to another commit, and the file is the new list's to pick. */
export function viewCommit(t: DiffTarget, c: Pick<CompareCommitView, "sha" | "parent">): Partial<DiffTarget> {
  const back = t.commit ?? { sha: "", base: t.base, head: t.head, file: t.file, oldPath: t.oldPath };
  return { ...commitSides(c), file: "", oldPath: "", commit: { ...back, sha: c.sha } };
}

/** What All changes sets: the sides and the file from before the first commit. */
export function leaveCommit(c: NonNullable<DiffTarget["commit"]>): Partial<DiffTarget> {
  return { base: c.base, head: c.head, file: c.file, oldPath: c.oldPath, commit: undefined };
}

/** How many rows the open list shows in a tab `height` tall: about two fifths of it in the rail. */
export function commitRows(count: number, height: number, rail: boolean): number {
  const fit = rail ? Math.min(RAIL_ROWS, Math.floor((height * 0.4) / COMMIT_ROW_H)) : TOP_ROWS;
  return Math.min(count, Math.max(fit, MIN_ROWS));
}

/** What the section takes from the list on top (topListFit). */
export function commitsHeight(count: number, height: number, rail: boolean, open: boolean): number {
  return COMMITS_HEADING_H + (open ? commitRows(count, height, rail) * COMMIT_ROW_H : 0);
}

/** A commit's page, for a project on GitHub; null otherwise. */
export function commitUrl(slug: string | undefined, sha: string): string | null {
  return slug ? `https://github.com/${slug}/commit/${sha}` : null;
}
