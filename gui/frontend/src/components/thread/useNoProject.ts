import { useShallow } from "zustand/react/shallow";
import { canMove } from "@/lib/move";
import { isNoProject } from "@/lib/threadRow";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";

/**
 * Whether a thread has no project (lib/threadRow isNoProject), from narrow selectors: its
 * owner fields and cwd, then one boolean over the projects. False for an unknown thread or
 * a null id.
 */
export function useNoProjectThread(id: string | null): boolean {
  const s = useThreadsStore(
    useShallow((st) => {
      const x = id === null ? undefined : st.byId[id];
      return x ? { projectId: x.projectId, workspaceId: x.workspaceId, worktreePath: x.worktreePath } : null;
    }),
  );
  return useProjectsStore((st) => s !== null && isNoProject(s, st));
}

/**
 * Whether the move picker is offered for a thread (lib/move canMove): no project, not
 * archived, not resident, not moving, transcript not deleted. Narrow selectors, as useNoProjectThread.
 */
export function useCanMove(id: string | null): boolean {
  const s = useThreadsStore(
    useShallow((st) => {
      const x = id === null ? undefined : st.byId[id];
      return x
        ? {
            projectId: x.projectId,
            workspaceId: x.workspaceId,
            worktreePath: x.worktreePath,
            archivedAtMs: x.archivedAtMs,
            resident: x.resident ?? "",
            moving: x.pendingMove !== null,
            transcriptMissing: x.transcriptMissing === true,
          }
        : null;
    }),
  );
  return useProjectsStore((st) => {
    if (s === null) return false;
    const { moving, transcriptMissing, ...rest } = s;
    return canMove({ ...rest, pendingMove: moving ? PENDING : null, ...(transcriptMissing ? { transcriptMissing: true as const } : {}) }, st);
  });
}

/** canMove reads only whether a move is pending. */
const PENDING = { projectId: "", workspaceId: "", worktreePath: "", branch: "" };
