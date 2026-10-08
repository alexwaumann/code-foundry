import { useState } from "react";
import type { GitOpView } from "@/api/gitops";
import { basename } from "@/lib/path";

/** Seconds with one decimal under 10s ("1.4s"), whole seconds above. */
function formatDuration(ms: number): string {
  if (ms <= 0) return "";
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

/** Body of the result toast: summary, worktree and duration; failures expand to the output. */
export function GitOpResult({ op }: { op: GitOpView }) {
  const failed = op.state === "failed";
  const [open, setOpen] = useState(false);
  const meta = [where(op), formatDuration(op.durationMs)].filter(Boolean).join(" · ");
  return (
    <div data-testid="gitop-toast" data-op-id={op.id} data-state={op.state} className="flex min-w-0 flex-col gap-1">
      <span data-testid="gitop-summary" className="break-words text-foreground">
        {op.summary}
      </span>
      {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
      {failed && op.output && (
        <>
          <button
            type="button"
            data-testid="gitop-output-toggle"
            className="self-start text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            onClick={() => {
              setOpen((v) => !v);
            }}
          >
            {open ? "Hide output" : "Show output"}
          </button>
          {open && (
            <pre
              data-testid="gitop-output"
              className="max-h-64 max-w-[22rem] overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-2 font-mono text-[11px] leading-snug text-foreground"
            >
              {op.output}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
