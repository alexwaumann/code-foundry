/**
 * project.worktree.cleanup confirms in its own dialog (components/projects/CleanupWorktreesDialog):
 * "Remove N merged worktrees?" and one row per worktree that goes (branch, and why in a few
 * words), from the daemon's dry run. Nothing about the worktrees that stay: one with
 * uncommitted work is never cleaned up (Remove worktree deletes it, asking first). Registered
 * as the command's confirm presenter, so every caller (the project menu, the "Remove the N
 * that are clean" button, the palette) gets it; without a project, or when the dry run fails,
 * the generic confirm asks with the daemon's words. docs/notes/cleanup-dialog.md.
 */
import { toast } from "sonner";
import { create } from "zustand";
import { previewCleanup, removedByCleanup, type CleanupRowView } from "@/api/project";
import { registerConfirmPresenter, requestConfirm, type ConfirmRequest } from "./confirm";
import { getUiContext } from "./context";

export const CLEANUP_COMMAND = "project.worktree.cleanup";

interface CleanupWorktreesState {
  pending: { rows: readonly CleanupRowView[]; resolve: (yes: boolean) => void } | null;
}

export const useCleanupWorktreesStore = create<CleanupWorktreesState>()(() => ({ pending: null }));

/** Opens the dialog on these rows; resolves true when the user removes. A second request cancels the first. */
export function requestCleanupWorktrees(rows: readonly CleanupRowView[]): Promise<boolean> {
  useCleanupWorktreesStore.getState().pending?.resolve(false);
  return new Promise((resolve) => {
    useCleanupWorktreesStore.setState({ pending: { rows, resolve } });
  });
}

/** Answers the open dialog. */
export function answerCleanupWorktrees(yes: boolean): void {
  const p = useCleanupWorktreesStore.getState().pending;
  if (!p) return;
  useCleanupWorktreesStore.setState({ pending: null });
  p.resolve(yes);
}

async function present(req: ConfirmRequest): Promise<boolean> {
  const project = req.args?.project || getUiContext().activeProjectId;
  if (!project) return requestConfirm(req);
  let rows: CleanupRowView[];
  try {
    rows = await previewCleanup(project, req.args?.path ?? "");
  } catch {
    return requestConfirm(req);
  }
  return requestCleanupWorktrees(rows);
}

registerConfirmPresenter(CLEANUP_COMMAND, present);

/** "Removed 4 worktrees" with the branches under it, or "No merged worktrees to remove". */
export function toastCleanupResult(resultJson: string): void {
  const gone = removedByCleanup(resultJson);
  if (gone.length === 0) {
    toast.success("No merged worktrees to remove");
    return;
  }
  toast.success(`Removed ${String(gone.length)} ${gone.length === 1 ? "worktree" : "worktrees"}`, {
    description: (
      <span className="block text-code text-cf-text-secondary" data-testid="cleanup-toast-branches">
        {gone.map((b) => (
          <span key={b} className="block truncate">
            {b}
          </span>
        ))}
      </span>
    ),
  });
}
