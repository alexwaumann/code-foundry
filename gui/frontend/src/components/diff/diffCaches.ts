/**
 * Bounded LRU caches for Diff tab and SourcePicker reads (CompareWorktree, ListCompareCommits,
 * GetWorktreeCompareFile, ListRefs). Switching tabs or toggling between files in a Diff tab
 * renders cached results immediately instead of discarding state; live worktree/status/file
 * changes and manual refreshes mark affected worktree entries stale so they revalidate.
 */
import type { CompareFileSidesView, CompareLogView, CompareView } from "@/api/compare";
import type { RefsView } from "@/api/project";
import { createTabReadCache } from "@/components/files/useTabRead";

const COMPARE_FILE_CACHE_MAX_BYTES = 16 * 1024 * 1024;
const sidesBytes = (s: CompareFileSidesView): number => (s.old.text.length + s.new.text.length) * 2;

export const compareWorktreeCache = createTabReadCache<CompareView>({ max: 24 });
export const compareLogCache = createTabReadCache<CompareLogView | null>({ max: 24 });
export const compareFileCache = createTabReadCache<CompareFileSidesView>({ max: 32, maxBytes: COMPARE_FILE_CACHE_MAX_BYTES, sizeOf: sidesBytes });
export const refsReadCache = createTabReadCache<RefsView>({ max: 32 });

/** Marks cached diff entries for `(projectId, worktree)` stale so revisits revalidate. */
export function invalidateWorktreeDiffCaches(projectId: string, worktree: string): void {
  const prefix = `${projectId}\u0000${worktree}\u0000`;
  const matches = (k: string) => k.startsWith(prefix);
  compareWorktreeCache.invalidate(matches);
  compareLogCache.invalidate(matches);
  compareFileCache.invalidate(matches);
}

/** Clears all diff and refs read caches (tests). */
export function clearDiffReadCaches(): void {
  compareWorktreeCache.clear();
  compareLogCache.clear();
  compareFileCache.clear();
  refsReadCache.clear();
}
