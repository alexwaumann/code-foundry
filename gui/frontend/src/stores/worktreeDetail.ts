import type { RepoEventView } from "@/api/repo";
import { getWorktreeDetail } from "@/api/worktreeDetail";
import { createResource } from "./resource";

const SEP = "\u0000";
export const detailKey = (repoId: string, path: string): string => `${repoId}${SEP}${path}`;

/**
 * RepoService.GetWorktreeDetail for the worktree on screen. Re-read on
 * worktree_detail_updated, and every 5 minutes so the daemon keeps recomputing it (it
 * does so for worktrees asked about in the last 10 minutes).
 */
export const worktreeDetailResource = createResource(
  (key, signal) => {
    const [repoId = "", path = ""] = key.split(SEP);
    return getWorktreeDetail(repoId, path, undefined, signal);
  },
  { keepAliveMs: 5 * 60_000 },
);

/** Repo events that affect details: detail changes, and snapshots (a reconnect). */
export function applyRepoEventToDetails(ev: RepoEventView): void {
  if (ev.kind === "worktreeDetailUpdated") worktreeDetailResource.invalidate(detailKey(ev.repoId, ev.path));
  else if (ev.kind === "snapshot") worktreeDetailResource.invalidate(() => true);
}
