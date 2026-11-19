import { Zap } from "lucide-react";
import { useMemo } from "react";
import type { PullRequestDetailView } from "@/api/gh";
import { DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem } from "@/components/ui/dropdown-menu";
import { setMergeMethodDefault, useMergeMethodDefault } from "@/stores/mergeDefaults";
import { setAutoMerge, usePullRequestChange } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { autoMergeHint, defaultMergeMethod, MERGE_METHOD_LABELS, mergeAvailability } from "./merge";
import { SplitButton } from "./SplitButton";

/**
 * The footer's Auto-merge, in Merge's place while requirements are pending and the
 * repository allows it: the main part turns GitHub's auto-merge on with the repository's
 * default method, the one Merge uses (pr.auto-merge --method … --head-sha: refused if the
 * head moved; the daemon confirms first, in the success tone). The menu picks that default,
 * as Merge's does: the pick closes it and turns nothing on.
 */
export function AutoMergeButton({ prRef, detail }: { prRef: PrRef; detail: PullRequestDetailView }) {
  const methods = useMemo(() => mergeAvailability(detail).methods, [detail]);
  const busy = usePullRequestChange(prRef) !== null;
  const picked = useMergeMethodDefault(prRef.slug);
  const method = defaultMergeMethod(methods, picked);
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
          <DropdownMenuLabel data-testid="pr-auto-merge-menu-heading">Merge once requirements pass · your pick becomes the default here</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={method}
            onValueChange={(v) => {
              const m = methods.find((x) => x === v);
              if (m) setMergeMethodDefault(prRef.slug, m);
            }}
          >
            {methods.map((m) => (
              <DropdownMenuRadioItem
                key={m}
                value={m}
                data-testid={`pr-auto-merge-method-${m}`}
                className="items-start [&>span:first-child]:top-2"
                onSelect={() => {
                  close();
                }}
              >
                <span className="flex min-w-0 flex-1 flex-col">
                  <span>{MERGE_METHOD_LABELS[m]}</span>
                  <span className="text-caption">{autoMergeHint(m)}</span>
                </span>
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </>
      )}
    </SplitButton>
  );
}
