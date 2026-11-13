import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { ThreadRequestView } from "@/api/thread";
import { diffStats, toolDiff, toolDiffFiles } from "@/lib/toolSummary";
import { ToolDiffView } from "./ToolDiffView";

/**
 * An Edit/Write waiting for permission: its +/− summary, and the diff, on demand in the pane's
 * card (PendingPrompt) and shown from the start in the Needs-you hover card (`open`), which offers
 * Allow only with the whole change on screen. Nothing for a request with no change to show.
 */
export function PromptDiff({ r, cwd, open: openAtFirst = false }: { r: Pick<ThreadRequestView, "toolName" | "inputJson">; cwd: string; open?: boolean }) {
  const diff = useMemo(() => toolDiff({ name: r.toolName, inputJson: r.inputJson, resultJson: "" }), [r.toolName, r.inputJson]);
  const stats = useMemo(() => (diff ? diffStats(toolDiffFiles(diff)) : null), [diff]);
  const [open, setOpen] = useState(openAtFirst);
  if (!diff || !stats) return null;
  const { added, removed } = stats;
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div className="pdiff" data-testid="thread-permission-diff">
      <button
        type="button"
        className="pdiff-t"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
      >
        <Chevron aria-hidden />
        {open ? "Hide the change" : "Show the change"}
        <span className="n add">+{added}</span>
        {removed > 0 && <span className="n del">−{removed}</span>}
      </button>
      {open && (
        <div className="pdiff-body">
          <ToolDiffView diff={diff} cwd={cwd} />
        </div>
      )}
    </div>
  );
}
