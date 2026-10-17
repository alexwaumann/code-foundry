/**
 * The composer's Work in choice remembered per project: picking "A fresh copy" or "The
 * project folder itself" for a project makes it that project's default for new threads,
 * over threads.default_worktree (lib/compose defaultWorktree). Picking another existing
 * worktree is a one-off and changes nothing. Persisted (localStorage
 * "code-foundry.workIn"); projects are never pruned.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { WorkInMode } from "@/lib/compose";

interface WorkInState {
  /** Project id → the last fresh-copy / in-place pick. */
  byProject: Readonly<Record<string, WorkInMode>>;
}

export const useWorkInStore = create<WorkInState>()(
  persist((): WorkInState => ({ byProject: {} }), {
    name: "code-foundry.workIn",
    // 2: byRepo is byProject (the rename of repo to project).
    version: 2,
    migrate: (persisted, version) => {
      const p = (persisted ?? {}) as { byRepo?: WorkInState["byProject"]; byProject?: WorkInState["byProject"] };
      return { byProject: (version < 2 ? p.byRepo : p.byProject) ?? {} };
    },
  }),
);

export function useRememberedWorkIn(projectId: string): WorkInMode | undefined {
  return useWorkInStore((s) => s.byProject[projectId]);
}

export function rememberedWorkIn(projectId: string): WorkInMode | undefined {
  return useWorkInStore.getState().byProject[projectId];
}

export function rememberWorkIn(projectId: string, mode: WorkInMode): void {
  if (!projectId || useWorkInStore.getState().byProject[projectId] === mode) return;
  useWorkInStore.setState((s) => ({ byProject: { ...s.byProject, [projectId]: mode } }));
}
