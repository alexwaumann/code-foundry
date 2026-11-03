import { GitMerge } from "lucide-react";
import { useMemo, useState } from "react";
import type { PullRequestDetailView } from "@/api/gh";
import { DropdownMenuCheckboxItem, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { pullRequestKey } from "@/stores/gh";
import { mergePullRequest, usePrPanelStore } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { branchDelete, defaultMergeMethod, MERGE_BUTTON_LABELS, MERGE_METHOD_LABELS, mergeAvailability, mergeMethodHint } from "./merge";
import { SplitButton } from "./SplitButton";

/**
 * The readiness box's Merge, at the footer's right: a split button whose main part merges
 * with the repository's default method (the one last chosen there, else squash) and whose
 * menu offers every method the repository allows plus "Delete branch after merge"
 * (origin's branch only; on unless it cannot be deleted). Merging runs pr.merge with the
 * head shown (the daemon's confirmation goes through the confirm dialog), with a spinner
 * until it answers. Disabled, with the reason as its tooltip and at the top of its menu,
 * when GitHub would refuse (draft, conflicts, blocked, behind, no method). `note` is one
 * more line in the menu (auto-merge being off for the repository).
 */
export function MergeButton({ prRef, detail, note = null }: { prRef: PrRef; detail: PullRequestDetailView; note?: string | null }) {
  const a = useMemo(() => mergeAvailability(detail), [detail]);
  const busy = usePrPanelStore((s) => s.merging[pullRequestKey(prRef.slug, prRef.number)] ?? false);
  const last = usePrPanelStore((s) => s.mergeMethods[prRef.slug.toLowerCase()]);
  const del = branchDelete(detail);
  const [deleteBranch, setDeleteBranch] = useState(true);
  if (!a.visible) return null;
  const pr = detail.pullRequest;
  const method = defaultMergeMethod(a.methods, last);
  const merge = (m: typeof method) => void mergePullRequest(prRef, m, deleteBranch && del.deletable, pr.headSha);
  return (
    <SplitButton
      icon={GitMerge}
      label={MERGE_BUTTON_LABELS[method]}
      tone="success"
      reason={a.reason}
      busy={busy}
      onRun={() => {
        merge(method);
      }}
      menuLabel="Merge options"
      testId="pr-merge-button"
    >
      {(close) => (
        <>
          <Tip label={`Merge into ${pr.baseRef}`} whenTruncated side="left">
            <DropdownMenuLabel className="truncate">
              Merge into <span className="font-mono">{pr.baseRef}</span>
            </DropdownMenuLabel>
          </Tip>
          {[a.reason, note, ...a.notes].filter((n): n is string => !!n).map((n) => (
            <p key={n} className="px-2 pb-1.5 text-caption text-cf-warning-text" data-testid="pr-merge-note">
              {n}
            </p>
          ))}
          {a.methods.map((m) => (
            <DropdownMenuItem
              key={m}
              data-testid={`pr-merge-method-${m}`}
              disabled={a.reason !== null}
              onSelect={() => {
                // Closed here, not by Radix: the merge makes the button busy in this same
                // event, so the controlled `open` is already false and Radix would skip
                // onOpenChange, leaving `open` set to reopen the menu once the merge ends.
                close();
                merge(m);
              }}
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span>{MERGE_METHOD_LABELS[m]}</span>
                <span className="text-caption">{mergeMethodHint(m, detail.commitCount, pr.baseRef)}</span>
              </span>
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuCheckboxItem
            data-testid="pr-merge-delete-branch"
            // pl-9: the box sits 12px from the menu's edge (4px menu padding + 8px); leave
            // the same 12px between it and the label.
            className="pl-9"
            checked={deleteBranch && del.deletable}
            disabled={!del.deletable}
            onCheckedChange={(v) => {
              setDeleteBranch(v);
            }}
            // Stay open: it is a setting for the merge that follows.
            onSelect={(e) => {
              e.preventDefault();
            }}
          >
            <span className="flex min-w-0 flex-1 flex-col">
              <span>Delete branch after merge</span>
              <span className="text-caption [overflow-wrap:anywhere]" data-testid="pr-merge-delete-branch-note">
                {del.subtitle}
              </span>
            </span>
          </DropdownMenuCheckboxItem>
        </>
      )}
    </SplitButton>
  );
}
