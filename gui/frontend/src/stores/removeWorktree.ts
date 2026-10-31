/**
 * project.worktree.remove confirms in its own dialog (components/projects/RemoveWorktreeDialog):
 * "Remove the worktree on <branch>?", the path that goes and the branch that stays, and
 * when the worktree has uncommitted entries the files that are lost. Registered as the
 * command's confirm presenter, so every caller (the Projects page's leftover rows and
 * checkout menu, the palette) gets it once the path is known; without one (the palette's
 * context-only invoke) the generic confirm asks.
 *
 * The daemon asks again, a second stage with force, when git refuses the removal for
 * uncommitted work. A yes in this dialog while it showed the loss answers that too (the
 * user saw what goes); otherwise (the files appeared after it opened) the dialog opens
 * again, now with the warning. docs/notes/projects-redesign-2-leftovers.md.
 */
import { create } from "zustand";
import { uncommittedCount } from "@/lib/leftovers";
import { registerConfirmPresenter, registerSecondStagePresenter, requestConfirm, type ConfirmRequest } from "./confirm";
import { useProjectsStore } from "./projects";

export const REMOVE_WORKTREE_COMMAND = "project.worktree.remove";

export interface RemoveWorktreeRequest {
  projectId: string;
  path: string;
}

interface RemoveWorktreeState {
  pending: (RemoveWorktreeRequest & { resolve: (yes: boolean) => void }) | null;
}

export const useRemoveWorktreeStore = create<RemoveWorktreeState>()(() => ({ pending: null }));

/** Worktree paths whose loss the user accepted in this dialog (consumed by the second stage). */
const accepted = new Set<string>();

/** Opens the dialog; resolves true when the user removes. A second request cancels the first. */
export function requestRemoveWorktree(req: RemoveWorktreeRequest): Promise<boolean> {
  useRemoveWorktreeStore.getState().pending?.resolve(false);
  return new Promise((resolve) => {
    useRemoveWorktreeStore.setState({ pending: { ...req, resolve } });
  });
}

/** Answers the open dialog. A yes while the worktree has uncommitted entries accepts their loss. */
export function answerRemoveWorktree(yes: boolean): void {
  const p = useRemoveWorktreeStore.getState().pending;
  if (!p) return;
  useRemoveWorktreeStore.setState({ pending: null });
  accepted.delete(p.path);
  if (yes && dirtyNow(p)) accepted.add(p.path);
  p.resolve(yes);
}

function worktreeOf(projectId: string, path: string) {
  return useProjectsStore.getState().byId[projectId]?.worktrees.find((w) => w.path === path);
}

function dirtyNow(r: RemoveWorktreeRequest): boolean {
  const w = worktreeOf(r.projectId, r.path);
  return w !== undefined && uncommittedCount(w.status) > 0;
}

/** The worktree a confirm request is about: its path arg, in its project arg's project or whichever has it. */
function targetOf(req: ConfirmRequest): RemoveWorktreeRequest | null {
  const path = req.args?.path ?? "";
  if (!path) return null;
  const projects = useProjectsStore.getState();
  const named = req.args?.project ?? "";
  const ids = named && projects.byId[named] ? [named] : projects.order;
  for (const id of ids) if (projects.byId[id]?.worktrees.some((w) => w.path === path && !w.isMain)) return { projectId: id, path };
  return null;
}

function present(req: ConfirmRequest): Promise<boolean> {
  // A new removal: nothing accepted before it carries over.
  accepted.delete(req.args?.path ?? "");
  // delete-branch and force change what goes: the daemon's own words say it.
  if (req.args?.["delete-branch"] === "true" || req.args?.force === "true") return requestConfirm(req);
  const t = targetOf(req);
  return t ? requestRemoveWorktree(t) : requestConfirm(req);
}

function presentSecond(req: ConfirmRequest): Promise<boolean> {
  const t = targetOf(req);
  if (!t) return requestConfirm(req);
  if (accepted.delete(t.path)) return Promise.resolve(true);
  return requestRemoveWorktree(t).finally(() => accepted.delete(t.path));
}

registerConfirmPresenter(REMOVE_WORKTREE_COMMAND, present);
registerSecondStagePresenter(REMOVE_WORKTREE_COMMAND, presentSecond);
