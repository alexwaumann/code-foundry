import type { GitOpView } from "@/api/gitops";
import { basename } from "@/lib/path";

/** "240ms", "1.4s" under 10s, whole seconds above. */
function formatDuration(ms: number): string {
  if (ms <= 0) return "";
  if (ms < 1000) return `${String(ms)}ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${String(Math.round(s))}s`;
}

/** The worktree an op ran in, for the toast's second line. */
function where(op: GitOpView): string {
  return op.worktreePath ? basename(op.worktreePath) : "";
}

/** Body of the progress toast while an operation is queued or running. */
export function GitOpProgress({ op }: { op: GitOpView }) {
  return (
    <span data-testid="gitop-toast" data-op-id={op.id} data-state={op.state} className="text-muted-foreground">
      {where(op)}
      {op.state === "queued" ? " · waiting for the previous operation" : ""}
    </span>
  );
}

/**
 * Body of the result toast: summary, worktree and duration; failures can expand to the
 * full output. `expanded` is owned by the caller, which re-issues the toast on toggle:
 * sonner measures a toast's height when its content props change, not when a child's
 * own state does, so local state would let the output spill out of the toast.
 */
export function GitOpResult({ op, expanded = false, onToggle }: { op: GitOpView; expanded?: boolean; onToggle?: () => void }) {
  const meta = [where(op), formatDuration(op.durationMs)].filter(Boolean).join(" · ");
  return (
    <div data-testid="gitop-toast" data-op-id={op.id} data-state={op.state} className="flex min-w-0 flex-col gap-1">
      <span data-testid="gitop-summary" className="break-words text-foreground">
        {op.summary}
      </span>
      {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
      {op.state === "failed" && op.output && onToggle && (
        <>
          <button
            type="button"
            data-testid="gitop-output-toggle"
            className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={onToggle}
          >
            {expanded ? "Hide output" : "Show output"}
          </button>
          {expanded && (
            <pre
              data-testid="gitop-output"
              className="max-h-64 w-full max-w-full overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px] leading-snug text-foreground"
            >
              {op.output}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
