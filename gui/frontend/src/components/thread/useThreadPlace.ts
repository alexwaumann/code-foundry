import { useShallow } from "zustand/react/shallow";
import { setLabel, threadRowModel, type ThreadPlaceInput, type WorkspaceLookup } from "@/lib/threadRow";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";

const NO_WORKSPACES: WorkspaceLookup = { byId: {} };

/** The fields of a thread its place line reads (shallow-stable: primitives only). */
export function useThreadPlaceInput(id: string): ThreadPlaceInput {
  return useThreadsStore(
    useShallow((st) => {
      const x = st.byId[id];
      return {
        projectId: x?.projectId ?? "",
        worktreePath: x?.worktreePath ?? "",
        workspaceId: x?.workspaceId ?? "",
        pendingWorktreePath: x?.pendingWorktreePath ?? "",
        projectCount: x?.projectIds.length ?? 0,
        branch: x?.branch ?? "",
        createdWorktree: x?.createdWorktree ?? false,
      };
    }),
  );
}

/**
 * A thread's place line (lib/threadRow threadRowModel), each part from a narrow selector
 * returning a primitive: "project @ branch", or for several projects "<workspace name> @
 * <branch>" / "<N projects> @ <branch>" (set), and a queued Run in move. The sidebar
 * row's line 2 and the Threads tab read it.
 */
export function useThreadPlace(id: string) {
  const s = useThreadPlaceInput(id);
  const set = useWorkspacesStore((st) => setLabel(s, st));
  const project = useProjectsStore((st) => threadRowModel(s, st, NO_WORKSPACES).project);
  const branch = useProjectsStore((st) => threadRowModel(s, st, NO_WORKSPACES).branch);
  const noGit = useProjectsStore((st) => threadRowModel(s, st, NO_WORKSPACES).noGit);
  const noProject = useProjectsStore((st) => threadRowModel(s, st, NO_WORKSPACES).noProject);
  const movingTo = useProjectsStore((st) => threadRowModel(s, st, NO_WORKSPACES).movingTo);
  return { project, branch, noGit, noProject, movingTo, set: noProject ? null : set };
}
