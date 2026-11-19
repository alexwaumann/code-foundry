import { FileDiff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { openPullRequestDiff } from "@/stores/prDiffPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { toneText } from "./tones";

/** The diffstat the button shows: GitHub's own counts from the pull request's detail. */
export interface DiffStat {
  files: number;
  added: number;
  deleted: number;
}

/**
 * The inner tab row's Diff button, at its right end: "Diff", the file count and the
 * +additions −deletions, the page's one diffstat. It gives way by the surface's width
 * (container queries): under 480px the file count goes, under 360px the counts too. A press
 * opens the pull request's diff tab beside its own tab, or shows the one already open
 * (openPullRequestDiff). No counts until the detail has them (`stat` null).
 */
export function DiffButton({ prRef, target, stat }: { prRef: PrRef; target: string; stat: DiffStat | null }) {
  return (
    <Button
      variant="outline"
      size="xs"
      className="shrink-0 text-cf-text"
      data-testid="pr-diff-button"
      onClick={() => {
        openPullRequestDiff(prRef, target || "current");
      }}
    >
      <FileDiff aria-hidden />
      Diff
      {stat && (
        <>
          <span className="font-normal text-cf-text-muted tabular-nums @max-[480px]:hidden" data-testid="pr-diff-button-files">
            {stat.files.toLocaleString()} {stat.files === 1 ? "file" : "files"}
          </span>
          <span className="font-normal tabular-nums @max-[360px]:hidden" data-testid="pr-diff-button-lines">
            <span className={toneText.success}>+{stat.added.toLocaleString()}</span> <span className={toneText.failure}>−{stat.deleted.toLocaleString()}</span>
          </span>
        </>
      )}
    </Button>
  );
}
