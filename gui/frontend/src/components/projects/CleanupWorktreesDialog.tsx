import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tip } from "@/components/ui/tooltip";
import type { CleanupRowView } from "@/api/project";
import { cleanupWords } from "@/lib/cleanup";
import { answerCleanupWorktrees, useCleanupWorktreesStore } from "@/stores/cleanupWorktrees";

function Row({ row }: { row: CleanupRowView }) {
  return (
    <li className="flex h-8 items-center gap-2 px-2" data-testid="cleanup-row" data-path={row.path}>
      <span className="size-1.5 shrink-0 rounded-full bg-cf-border-strong" aria-hidden />
      <Tip label={row.branch} whenTruncated align="start">
        <span className="min-w-0 flex-1 truncate text-code" data-testid="cleanup-branch">
          {row.branch}
        </span>
      </Tip>
      {row.kind && (
        <span className="shrink-0 text-body-sm text-cf-text-muted" data-testid="cleanup-kind">
          {row.kind}
        </span>
      )}
    </li>
  );
}

/**
 * project.worktree.cleanup's confirm (stores/cleanupWorktrees.tsx): what goes, one row per
 * worktree (branch, and why in a few words: merged, squash-merged, no commits), and that
 * branches stay. No paths and nothing about what stays. With nothing to remove right now
 * it offers the fetch alone (the daemon checks again after it).
 */
export function CleanupWorktreesDialog() {
  const pending = useCleanupWorktreesStore((s) => s.pending);
  const rows = pending?.rows ?? [];
  const base = rows.find((r) => r.baseRef)?.baseRef || "the default branch";
  const words = cleanupWords(rows.length, base);
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) answerCleanupWorktrees(false);
      }}
    >
      <DialogContent className="max-w-md p-5" data-testid="cleanup-dialog">
        <div className="min-w-0 space-y-3">
          <DialogTitle data-testid="cleanup-title">{words.title}</DialogTitle>
          <DialogDescription data-testid="cleanup-body">{words.body}</DialogDescription>
          {rows.length > 0 && (
            <ul className="max-h-72 overflow-y-auto rounded-lg border p-0.5" data-testid="cleanup-rows">
              {rows.map((r) => (
                <Row key={r.path} row={r} />
              ))}
            </ul>
          )}
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            data-testid="cleanup-cancel"
            onClick={() => {
              answerCleanupWorktrees(false);
            }}
          >
            Cancel
          </Button>
          <Button
            variant={rows.length > 0 ? "destructive" : "default"}
            size="sm"
            autoFocus
            data-testid="cleanup-ok"
            onClick={() => {
              answerCleanupWorktrees(true);
            }}
          >
            {words.confirm}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
