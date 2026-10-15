import { useEffect, useState } from "react";
import { CircleX, Loader2, Play, X } from "lucide-react";
import { getActionRun, type ActionRunOutputView } from "@/api/actions";
import { errorMessage } from "@/api/stream";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatRunDuration } from "@/lib/actions";
import { splitPathTail, tildify } from "@/lib/path";
import { runAction } from "@/stores/actionActions";
import { closeActionRunOutput, useActionDialogStore } from "@/stores/actionDialog";

type Load = { phase: "loading" } | { phase: "loaded"; data: ActionRunOutputView } | { phase: "error"; message: string };

/**
 * A finished background run's captured output (ActionService.GetRun, a read), for the
 * failed-setup toast's Open: the daemon runs worktree-create actions in the background, so
 * there is no tab to show. "Run in terminal" runs the action again for the thread, as a tab.
 */
function RunOutput({ runId }: { runId: string }) {
  const [load, setLoad] = useState<Load>({ phase: "loading" });
  useEffect(() => {
    const ac = new AbortController();
    getActionRun(runId, undefined, ac.signal).then(
      (data) => {
        setLoad(data ? { phase: "loaded", data } : { phase: "error", message: "The daemon no longer remembers this run." });
      },
      (err: unknown) => {
        if (!ac.signal.aborted) setLoad({ phase: "error", message: errorMessage(err) });
      },
    );
    return () => {
      ac.abort();
    };
  }, [runId]);

  if (load.phase === "loading")
    return (
      <p className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" aria-hidden /> Loading the output…
      </p>
    );
  if (load.phase === "error")
    return (
      <p className="mt-3 text-sm text-destructive" role="alert">
        {load.message}
      </p>
    );
  const { run, output, truncated } = load.data;
  const took = run.startedAtMs !== null && run.finishedAtMs !== null ? formatRunDuration(run.finishedAtMs - run.startedAtMs) : null;
  const path = splitPathTail(tildify(run.worktreePath));
  const owner = run.sessionId ? ({ kind: "thread", sessionId: run.sessionId } as const) : ({ kind: "worktree", repoId: run.repoId, path: run.worktreePath } as const);
  return (
    <>
      {/* One line: only the path gives way, its directory first (a middle ellipsis), so the
          branch folder at its end stays readable. */}
      <DialogDescription className="mt-1 flex items-center gap-1.5 pr-7 text-xs whitespace-nowrap text-muted-foreground" data-testid="action-run-meta">
        <CircleX className="size-3.5 shrink-0 text-red-600 dark:text-red-400" aria-hidden />
        <span className="shrink-0 text-red-600 dark:text-red-400">Exited with code {run.exitCode}</span>
        {took && (
          <span aria-hidden className="shrink-0 opacity-50">
            ·
          </span>
        )}
        {took && <span className="shrink-0 tabular-nums">{took}</span>}
        <span aria-hidden className="shrink-0 opacity-50">
          ·
        </span>
        <span className="flex min-w-0 font-mono" title={run.worktreePath} data-testid="action-run-path">
          <span className="min-w-0 shrink-[1000] truncate">{path.head}</span>
          <span className="min-w-0 truncate">{path.tail}</span>
        </span>
      </DialogDescription>
      <p className="mt-3 truncate font-mono text-xs text-muted-foreground" title={run.command}>
        $ {run.command.split("\n")[0]}
      </p>
      <pre className="mt-1 max-h-72 overflow-auto rounded-md border bg-pane p-2.5 font-mono text-xs leading-[17px] whitespace-pre-wrap" data-testid="action-run-output">
        {truncated && <span className="text-muted-foreground">…{"\n"}</span>}
        {output || <span className="text-muted-foreground">(no output)</span>}
      </pre>
      <div className="mt-4 flex items-center justify-end gap-2">
        <DialogClose asChild>
          <Button type="button" size="sm" variant="outline">
            Close
          </Button>
        </DialogClose>
        <Button
          type="button"
          size="sm"
          data-testid="action-run-again"
          onClick={() => {
            closeActionRunOutput();
            void runAction(run.actionId, owner);
          }}
        >
          <Play aria-hidden />
          Run in terminal
        </Button>
      </div>
    </>
  );
}

/** The failed setup run's output (stores/actionDialog.ts runId). */
export function ActionRunDialog() {
  const runId = useActionDialogStore((s) => s.runId);
  const seq = useActionDialogStore((s) => s.seq);
  const name = useActionDialogStore((s) => s.runName);
  return (
    <Dialog
      open={runId !== null}
      onOpenChange={(o) => {
        if (!o) closeActionRunOutput();
      }}
    >
      <DialogContent className="max-w-2xl p-4" data-testid="action-run-dialog">
        <DialogTitle>Setup action {name} failed</DialogTitle>
        {runId !== null && <RunOutput key={seq} runId={runId} />}
        <DialogClose
          className="absolute top-2.5 right-2.5 flex size-8 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          aria-label="Close"
        >
          <X className="size-4" aria-hidden />
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
