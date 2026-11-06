import { Zap } from "lucide-react";
import { useMemo } from "react";
import type { PullRequestDetailView } from "@/api/gh";
import { DropdownMenuItem, DropdownMenuLabel } from "@/components/ui/dropdown-menu";
import { setAutoMerge, usePrPanelStore, usePullRequestChange } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { autoMergeHint, defaultMergeMethod, MERGE_METHOD_LABELS, mergeAvailability } from "./merge";
import { SplitButton } from "./SplitButton";

/**
 * The footer's Auto-merge, in Merge's place while requirements are pending and the
 * repository allows it: the main part turns GitHub's auto-merge on with the default
 * method (pr.auto-merge --method … --head-sha: refused if the head moved; the daemon
 * confirms first), the menu picks another.
 */
export function AutoMergeButton({ prRef, detail }: { prRef: PrRef; detail: PullRequestDetailView }) {
  const methods = useMemo(() => mergeAvailability(detail).methods, [detail]);
  const busy = usePullRequestChange(prRef) !== null;
  const last = usePrPanelStore((s) => s.mergeMethods[prRef.slug.toLowerCase()]);
  const method = defaultMergeMethod(methods, last);
  const head = detail.pullRequest.headSha;
  return (
    <SplitButton
      icon={Zap}
      label="Auto-merge"
      tone="neutral"
      reason={null}
      busy={busy}
      onRun={() => void setAutoMerge(prRef, method, head)}
      menuLabel="Auto-merge options"
      testId="pr-auto-merge-button"
    >
      {(close) => (
        <>
          <DropdownMenuLabel>Merge once requirements pass</DropdownMenuLabel>
          {methods.map((m) => (
            <DropdownMenuItem
              key={m}
              data-testid={`pr-auto-merge-method-${m}`}
              onSelect={() => {
                close();
                void setAutoMerge(prRef, m, head);
              }}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{MERGE_METHOD_LABELS[m]}</span>
                <span className="text-caption">{autoMergeHint(m)}</span>
              </span>
            </DropdownMenuItem>
          ))}
        </>
      )}
    </SplitButton>
  );
}
