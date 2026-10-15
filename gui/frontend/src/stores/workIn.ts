/**
 * The composer's Work in choice remembered per project: picking "A fresh copy" or "The
 * project folder itself" for a project makes it that project's default for new threads,
 * over sessions.default_worktree (lib/compose defaultWorktree). Picking another existing
 * worktree is a one-off and changes nothing. Persisted (localStorage
 * "code-foundry.workIn"); projects are never pruned.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { WorkInMode } from "@/lib/compose";

interface WorkInState {
  /** Repo id → the last fresh-copy / in-place pick. */
  byRepo: Readonly<Record<string, WorkInMode>>;
}

export const useWorkInStore = create<WorkInState>()(persist((): WorkInState => ({ byRepo: {} }), { name: "code-foundry.workIn", version: 1 }));

export function useRememberedWorkIn(repoId: string): WorkInMode | undefined {
  return useWorkInStore((s) => s.byRepo[repoId]);
}

export function rememberedWorkIn(repoId: string): WorkInMode | undefined {
  return useWorkInStore.getState().byRepo[repoId];
}

export function rememberWorkIn(repoId: string, mode: WorkInMode): void {
  if (!repoId || useWorkInStore.getState().byRepo[repoId] === mode) return;
  useWorkInStore.setState((s) => ({ byRepo: { ...s.byRepo, [repoId]: mode } }));
}
