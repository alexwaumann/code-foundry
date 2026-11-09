import { useShallow } from "zustand/react/shallow";
import type { ThreadView } from "@/api/threads";
import { setLabel, threadRowModel, type ThreadPlaceInput, type ThreadRowModel, type WorkspaceLookup } from "@/lib/threadRow";
import { useProjectsStore } from "@/stores/projects";
import { useThreadsStore } from "@/stores/threads";
import { useWorkspacesStore } from "@/stores/workspaces";

const NO_WORKSPACES: WorkspaceLookup = { byId: {} };

/** The fields of a thread its place line reads, primitives only (an unknown thread: all empty). */
export function placeInputOf(x: ThreadView | undefined): ThreadPlaceInput {
  return {
    projectId: x?.projectId ?? "",
    worktreePath: x?.worktreePath ?? "",
    workspaceId: x?.workspaceId ?? "",
    pendingWorktreePath: x?.pendingWorktreePath ?? "",
    projectCount: x?.projectIds.length ?? 0,
    branch: x?.branch ?? "",
    createdWorktree: x?.createdWorktree ?? false,
  };
}

/** The fields of a thread its place line reads (shallow-stable: primitives only). */
export function useThreadPlaceInput(id: string): ThreadPlaceInput {
  return useThreadsStore(useShallow((st) => placeInputOf(st.byId[id])));
}

/**
 * Whether a thread's sidebar row has a branch line (its third): it has a project with git,
 * whether or not the branch is known yet (a thread being set up names it a moment later, and
 * its row must not grow then). A thread without a project or without git has a two-line row
 * (docs/notes/sidebar-title-first.md).
 */
export function rowHasBranchLine(m: Pick<ThreadRowModel, "noProject" | "noGit">): boolean {
  return !m.noProject && !m.noGit;
}

/**
 * The thread ids among `ids` whose rows have no branch line (rowHasBranchLine), joined
 * by newlines: a primitive, so the list re-measures only when one of them changes.
 */
export function useBranchlessRows(ids: readonly string[]): string {
  const inputs = useThreadsStore(useShallow((st) => ids.map((id) => JSON.stringify(placeInputOf(st.byId[id])))));
  return useProjectsStore((st) =>
    ids.filter((_, i) => !rowHasBranchLine(threadRowModel(JSON.parse(inputs[i] ?? "{}") as ThreadPlaceInput, st, NO_WORKSPACES))).join("\n"),
  );
}

/**
 * A thread's place line (lib/threadRow threadRowModel), each part from a narrow selector
 * returning a primitive: "project @ branch", or for several projects "<workspace name> @
 * <branch>" / "<N projects> @ <branch>" (set), and a queued Run in move. The sidebar
 * row's line 2 (the run-in project only, the set label only for a workspace folder:
 * inFolder) reads it.
 */
export function useThreadPlace(id: string) {
  const s = useThreadPlaceInput(id);
  const set = useWorkspacesStore((st) => setLabel(s, st));
  const project = useProjectsStore((st) => threadRowModel(s, st, NO_WORKSPACES).project);
  const branch = useProjectsStore((st) => threadRowModel(s, st, NO_WORKSPACES).branch);
  const noGit = useProjectsStore((st) => threadRowModel(s, st, NO_WORKSPACES).noGit);
  const noProject = useProjectsStore((st) => threadRowModel(s, st, NO_WORKSPACES).noProject);
  const movingTo = useProjectsStore((st) => threadRowModel(s, st, NO_WORKSPACES).movingTo);
  // A thread in its workspace's folder (no project id): the place is the folder, named by the set label.
  const inFolder = !noProject && s.projectId === "" && s.workspaceId !== "";
  return { project, branch, noGit, noProject, movingTo, set: noProject ? null : set, inFolder };
}
