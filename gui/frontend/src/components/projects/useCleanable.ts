import { useShallow } from "zustand/react/shallow";
import { memberHolds, terminalHolds, threadHolds } from "@/lib/projects";
import { findWorktree, useReposStore } from "@/stores/repos";
import { useSessionsStore } from "@/stores/threads";
import { useTerminalsStore } from "@/stores/terminals";
import { useWorkspacesStore } from "@/stores/workspaces";

/**
 * Whether repo.worktree.cleanup would remove this worktree now (lib/projects.ts
 * isCleanable). Each store is asked one boolean, and only once git says merged and clean.
 */
export function useCleanable(repoId: string, path: string): boolean {
  const merged = useReposStore((s) => findWorktree(s, repoId, path)?.mergedClean ?? false);
  const thread = useSessionsStore((s) => merged && threadHolds(s, path));
  const terminal = useTerminalsStore((s) => merged && terminalHolds(s, path));
  const member = useWorkspacesStore((s) => merged && memberHolds(s, path));
  return merged && !thread && !terminal && !member;
}

/** How many of the project's worktrees repo.worktree.cleanup would remove now. */
export function useCleanableCount(repoId: string): number {
  const candidates = useReposStore(useShallow((s) => (s.byId[repoId]?.worktrees ?? []).filter((w) => w.mergedClean === true && !w.isMain).map((w) => w.path)));
  const byThread = useSessionsStore(useShallow((s) => candidates.filter((p) => threadHolds(s, p))));
  const byTerminal = useTerminalsStore(useShallow((s) => candidates.filter((p) => terminalHolds(s, p))));
  const byMember = useWorkspacesStore(useShallow((s) => candidates.filter((p) => memberHolds(s, p))));
  const held = new Set([...byThread, ...byTerminal, ...byMember]);
  return candidates.filter((p) => !held.has(p)).length;
}
