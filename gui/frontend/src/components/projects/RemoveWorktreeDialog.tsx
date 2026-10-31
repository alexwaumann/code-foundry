import { useMemo } from "react";
import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { lossFiles, lossLine, uncommittedCount } from "@/lib/leftovers";
import { tildify } from "@/lib/path";
import { openChangesTab } from "@/stores/changesPanel";
import { findWorktree, useProjectsStore } from "@/stores/projects";
import { answerRemoveWorktree, useRemoveWorktreeStore } from "@/stores/removeWorktree";
import { useResource } from "@/stores/resource";
import { detailKey, worktreeDetailResource } from "@/stores/worktreeDetail";

/**
 * The uncommitted files that go, from the worktree's detail (the Changes tab's resource):
 * the first three paths, "and N more", and Show diff (the Changes tab; the dialog closes).
 */
function Loss({ projectId, path, count }: { projectId: string; path: string; count: number }) {
  const entry = useResource(worktreeDetailResource, detailKey(projectId, path));
  const files = useMemo(() => (entry?.data?.files ?? []).filter((f) => f.uncommitted).map((f) => f.path), [entry?.data]);
  const { names, more } = lossFiles(files, Math.max(count, files.length));
  return (
    <div className="flex gap-2.5 rounded-lg border bg-cf-surface px-3 py-2.5" data-testid="remove-worktree-loss">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-cf-warning-text" aria-hidden />
      <div className="min-w-0 text-body-sm">
        <p data-testid="remove-worktree-loss-count">{lossLine(count)}</p>
        <p className="mt-0.5 break-words text-cf-text-muted" data-testid="remove-worktree-loss-files">
          {names && (
            <>
              {names}
              {more > 0 && ` and ${String(more)} more`}
              {" · "}
            </>
          )}
          <button
            type="button"
            className="text-link hover:underline"
            data-testid="remove-worktree-show-diff"
            onClick={() => {
              answerRemoveWorktree(false);
              openChangesTab("current", projectId, path);
            }}
          >
            Show diff
          </button>
        </p>
      </div>
    </div>
  );
}

/**
 * project.worktree.remove's confirm (stores/removeWorktree.ts): "Remove the worktree on
 * <branch>?", "<path> goes. The branch <branch> stays.", and while it has uncommitted entries
 * a warning naming them. Remove has focus, so Enter removes and Escape cancels.
 */
export function RemoveWorktreeDialog() {
  const pending = useRemoveWorktreeStore((s) => s.pending);
  const projectId = pending?.projectId ?? "";
  const path = pending?.path ?? "";
  const branch = useProjectsStore((s) => (pending ? (findWorktree(s, projectId, path)?.branch ?? "") : ""));
  const count = useProjectsStore((s) => {
    const w = pending ? findWorktree(s, projectId, path) : undefined;
    return w ? uncommittedCount(w.status) : 0;
  });
  const name = path.slice(path.lastIndexOf("/") + 1);
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) answerRemoveWorktree(false);
      }}
    >
      <DialogContent className="max-w-md p-5" data-testid="remove-worktree-dialog" data-dirty={count > 0 || undefined}>
        <div className="min-w-0 space-y-3">
          <DialogTitle data-testid="remove-worktree-title">{branch ? `Remove the worktree on ${branch}?` : `Remove the worktree ${name}?`}</DialogTitle>
          <DialogDescription className="break-words" data-testid="remove-worktree-body">
            {tildify(path)} goes.
            {branch && (
              <>
                {" "}
                The branch <span className="text-code">{branch}</span> stays.
              </>
            )}
          </DialogDescription>
          {pending && count > 0 && <Loss projectId={projectId} path={path} count={count} />}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="remove-worktree-cancel"
            onClick={() => {
              answerRemoveWorktree(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            autoFocus
            data-testid="remove-worktree-ok"
            onClick={() => {
              answerRemoveWorktree(true);
            }}
          >
            Remove worktree
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
