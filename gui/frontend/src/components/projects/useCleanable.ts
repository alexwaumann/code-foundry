import { useShallow } from "zustand/react/shallow";
import { terminalHolds, threadHolds } from "@/lib/projects";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useTerminalsStore } from "@/stores/terminals";

/** How many of the project's worktrees project.worktree.cleanup would remove now. */
export function useCleanableCount(projectId: string): number {
  const candidates = useProjectsStore(useShallow((s) => (s.byId[projectId]?.worktrees ?? []).filter((w) => w.mergedClean === true && !w.isMain).map((w) => w.path)));
  const byThread = useThreadsStore(useShallow((s) => candidates.filter((p) => threadHolds(s, p))));
  const byTerminal = useTerminalsStore(useShallow((s) => candidates.filter((p) => terminalHolds(s, p))));
  const held = new Set([...byThread, ...byTerminal]);
  return candidates.filter((p) => !held.has(p)).length;
}
