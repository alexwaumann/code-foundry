import { memo, useMemo } from "react";
import { Copy } from "lucide-react";
import { CodeDiff, CodeScroll } from "@/components/code/CodeDiff";
import { Tip } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { diffText, splitPath, toolDiffFiles, type ToolDiff } from "@/lib/toolSummary";

/** Above this many rendered lines the diff scrolls in a bounded box that lays out only what is visible. */
const VIRTUALIZE_LINES = 400;

/**
 * An Edit / Write / NotebookEdit row's diff (and the docked permission prompt's): the file
 * header (path, Copy diff), then the diff on @pierre/diffs (components/code/CodeDiff). A
 * MultiEdit shows one diff per edit. Lines wrap, as the rest of the thread's output does;
 * unified or split follows the codeView store.
 */
export const ToolDiffView = memo(function ToolDiffView({ diff, cwd }: { diff: ToolDiff; cwd: string }) {
  const files = useMemo(() => toolDiffFiles(diff), [diff]);
  const lines = files.reduce((n, f) => n + f.unifiedLineCount, 0);
  const { base, dir } = splitPath(diff.path, cwd);
  const body =
    diff.kind === "patch" ? (
      <CodeDiff patch={diff.patch} wrap />
    ) : (
      diff.pairs.map((p, i) => (
        <CodeDiff key={i} oldFile={p.oldText === null ? null : { name: diff.name, contents: p.oldText }} newFile={{ name: diff.name, contents: p.newText }} lineNumbers={diff.numbered} wrap />
      ))
    );
  return (
    <div className="diff selectable" data-testid="thread-diff">
      <div className="dh">
        <Tip label={diff.path} align="start">
          <span className="path">
            {dir && <span className="dir">{dir}/</span>}
            {base}
          </span>
        </Tip>
        <span className="flex-1" />
        <Tip label="Copy diff">
          <button
            type="button"
            className="flex size-[22px] items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Copy diff"
            onClick={() => void copyText(diffText(diff, files))}
          >
            <Copy className="size-3" />
          </button>
        </Tip>
      </div>
      {lines > VIRTUALIZE_LINES ? <CodeScroll className="diff-scroll">{body}</CodeScroll> : body}
    </div>
  );
});
