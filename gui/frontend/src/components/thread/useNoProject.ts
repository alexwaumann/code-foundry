import { useShallow } from "zustand/react/shallow";
import { isNoProject } from "@/lib/threadRow";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";

/**
 * Whether a thread has no project (lib/threadRow isNoProject), from narrow selectors: its
 * owner fields and cwd, then one boolean over the repos. False for an unknown thread or
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
