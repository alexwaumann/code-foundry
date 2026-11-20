import { GitMerge } from "lucide-react";
import { useEffect, useId, useMemo, useState } from "react";
import type { PullRequestDetailView } from "@/api/gh";
import { DropdownMenuCheckboxItem, DropdownMenuLabel, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { closeMergeDialog, openMergeDialog, useMergeDialogOpen } from "@/stores/mergeDialog";
import { setMergeMethodDefault, useMergeMethodDefault } from "@/stores/mergeDefaults";
import { mergePullRequest, useMergingMethod } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { branchDelete, defaultMergeMethod, MERGE_BUSY_LABELS, MERGE_BUTTON_LABELS, MERGE_METHOD_LABELS, mergeAvailability, mergeMethodHint, type MergeAvailability } from "./merge";
import { MergeDialog } from "./MergeDialog";
import { SplitButton } from "./SplitButton";

/**
 * The readiness box's Merge, at the footer's right: a split button whose main part opens
 * the merge dialog (MergeDialog) with the repository's default method (the one picked
 * last there, stores/mergeDefaults.ts, else squash), and whose menu picks the default:
 * a pick there changes the main part's words and closes the menu, and merges nothing. The
 * menu also holds "Delete branch after merge" (origin's branch only; on unless it cannot
 * be deleted), which the dialog shows again. The dialog's Merge runs pr.merge with the
 * head shown, already asked (mergePullRequest's `asked`: one question, the dialog's), and
 * the button is busy in that method's words ("Squashing and merging…") until the detail
 * shows it merged. Disabled, with the reason as its tooltip and at the top of its menu,
 * when GitHub would refuse (draft, conflicts, blocked, behind, no method). `note` is one
 * more line in the menu (auto-merge being off for the repository).
 */
export function MergeButton({ prRef, detail, note = null }: { prRef: PrRef; detail: PullRequestDetailView; note?: string | null }) {
  const a = useMemo(() => mergeAvailability(detail), [detail]);
  // Hidden, the shown part unmounts, and its cleanup shuts a dialog it left open.
  if (!a.visible) return null;
  return <ShownMergeButton prRef={prRef} detail={detail} note={note} a={a} />;
}

/**
 * The button while it shows, and its dialog's open flag (stores/mergeDialog.ts), which goes
 * with it: a page's guarded question never waits behind a dialog whose button is gone.
 */
function ShownMergeButton({ prRef, detail, note, a }: { prRef: PrRef; detail: PullRequestDetailView; note: string | null; a: MergeAvailability }) {
  const merging = useMergingMethod(prRef);
  const picked = useMergeMethodDefault(prRef.slug);
  const del = branchDelete(detail);
  const [deleteBranch, setDeleteBranch] = useState(true);
  const dialogId = useId();
  const dialogOpen = useMergeDialogOpen(dialogId);
  useEffect(
    () => () => {
      closeMergeDialog(dialogId);
    },
    [dialogId],
  );
  const pr = detail.pullRequest;
  const method = defaultMergeMethod(a.methods, picked);
  const pick = (v: string) => {
    const m = a.methods.find((x) => x === v);
    if (m) setMergeMethodDefault(prRef.slug, m);
  };
  return (
    <>
      <SplitButton
        icon={GitMerge}
        label={merging ? MERGE_BUSY_LABELS[merging] : MERGE_BUTTON_LABELS[method]}
        tone="success"
        reason={a.reason}
        busy={merging !== null}
        onRun={() => {
          openMergeDialog(dialogId, prRef);
        }}
        menuLabel="Merge options"
        testId="pr-merge-button"
      >
        {(close) => (
          <>
            {/* Wraps rather than cuts: the second half is the rule a pick follows. */}
            <DropdownMenuLabel className="[overflow-wrap:anywhere]" data-testid="pr-merge-menu-heading">
              Merge into <span className="font-mono">{pr.baseRef}</span> · your pick becomes the default here
            </DropdownMenuLabel>
            {[a.reason, note, ...a.notes].filter((n): n is string => !!n).map((n) => (
              <p key={n} className="px-2 pb-1.5 text-caption text-cf-warning-text" data-testid="pr-merge-note">
                {n}
              </p>
            ))}
            <DropdownMenuRadioGroup value={method} onValueChange={pick}>
              {a.methods.map((m) => (
                <DropdownMenuRadioItem
                  key={m}
                  value={m}
                  data-testid={`pr-merge-method-${m}`}
                  // The tick sits at the top beside two lines, in the merge's tone.
                  className="items-start [&>span:first-child]:top-2 [&>span:first-child]:text-cf-success-text"
                  onSelect={() => {
                    // Closed here as well as by Radix: the pick is the whole action.
                    close();
                  }}
                >
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span>{MERGE_METHOD_LABELS[m]}</span>
                    <span className="text-caption">{mergeMethodHint(m, detail.commitCount, pr.baseRef)}</span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
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
      <MergeDialog
        prRef={prRef}
        open={dialogOpen}
        onOpenChange={(open) => {
          if (!open) closeMergeDialog(dialogId);
        }}
        detail={detail}
        methods={a.methods}
        method={method}
        onMethod={(m) => {
          setMergeMethodDefault(prRef.slug, m);
        }}
        deletable={del.deletable}
        deleteBranch={deleteBranch}
        onDeleteBranch={setDeleteBranch}
        reason={a.reason}
        onConfirm={() => {
          closeMergeDialog(dialogId);
          void mergePullRequest(prRef, method, deleteBranch && del.deletable, pr.headSha, { asked: true });
        }}
      />
    </>
  );
}
