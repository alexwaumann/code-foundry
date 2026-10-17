import { useShallow } from "zustand/react/shallow";
import { memberHolds, terminalHolds, threadHolds } from "@/lib/projects";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useTerminalsStore } from "@/stores/terminals";
import { useWorkspacesStore } from "@/stores/workspaces";

/**
 * Whether project.worktree.cleanup would remove this worktree now (lib/projects.ts
 * isCleanable). Each store is asked one boolean, and only once git says merged and clean.
 */
export function useCleanable(projectId: string, path: string): boolean {
  const merged = useProjectsStore((s) => findWorktree(s, projectId, path)?.mergedClean ?? false);
  const thread = useThreadsStore((s) => merged && threadHolds(s, path));
  const terminal = useTerminalsStore((s) => merged && terminalHolds(s, path));
  const member = useWorkspacesStore((s) => merged && memberHolds(s, path));
  return merged && !thread && !terminal && !member;
}

/** How many of the project's worktrees project.worktree.cleanup would remove now. */
export function useCleanableCount(projectId: string): number {
  const candidates = useProjectsStore(useShallow((s) => (s.byId[projectId]?.worktrees ?? []).filter((w) => w.mergedClean === true && !w.isMain).map((w) => w.path)));
  const byThread = useThreadsStore(useShallow((s) => candidates.filter((p) => threadHolds(s, p))));
  const byTerminal = useTerminalsStore(useShallow((s) => candidates.filter((p) => terminalHolds(s, p))));
  const byMember = useWorkspacesStore(useShallow((s) => candidates.filter((p) => memberHolds(s, p))));
  const held = new Set([...byThread, ...byTerminal, ...byMember]);
  return candidates.filter((p) => !held.has(p)).length;
}
