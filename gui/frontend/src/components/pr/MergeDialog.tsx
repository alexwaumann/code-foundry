import { GitMerge } from "lucide-react";
import { useId } from "react";
import type { MergeMethodView, PullRequestDetailView } from "@/api/gh";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { MERGE_BUTTON_LABELS, MERGE_SHORT_LABELS, mergeOutcome } from "./merge";
import { PrDialogHeading } from "./PrDialogHeading";

/** The merge dialog's confirm: the merge button's success fill (SplitButton's tone). */
const successButton = "bg-cf-success text-cf-success-foreground hover:bg-cf-success/90";

/** One labelled row of the summary. */
function Row({ label, children, testId }: { label: string; children: React.ReactNode; testId: string }) {
  return (
    <div className="flex min-h-9 items-center gap-2.5 px-2.5 py-1.5" data-testid={testId}>
      <span className="w-14 shrink-0 text-caption">{label}</span>
      {children}
    </div>
  );
}

/**
 * The merge button's question, asked before pr.merge runs and instead of the command's own
 * (mergePullRequest's `asked`): a calm dialog, the merge icon in the success tone, titled
 * with the method alone, then owner/repo #number and the pull request's title
 * (PrDialogHeading). Its rows say where it
 * merges (and what the method does to the commits), from which branch, how (the methods
 * the repository allows; a pick there is the repository's default at once, as in the
 * menu), and whether origin's branch goes (only when it can). `reason`, when set, is why
 * GitHub would refuse now (the pull request changed while it was open): said, and the
 * confirm is off. Confirm has the focus: Enter merges, Escape cancels.
 */
export function MergeDialog({
  prRef,
  open,
  onOpenChange,
  detail,
  methods,
  method,
  onMethod,
  deletable,
  deleteBranch,
  onDeleteBranch,
  reason,
  onConfirm,
}: {
  prRef: PrRef;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  detail: PullRequestDetailView;
  methods: readonly MergeMethodView[];
  method: MergeMethodView;
  onMethod: (m: MergeMethodView) => void;
  deletable: boolean;
  deleteBranch: boolean;
  onDeleteBranch: (v: boolean) => void;
  reason: string | null;
  onConfirm: () => void;
}) {
  const pr = detail.pullRequest;
  const deleteId = useId();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md p-5" data-testid="pr-merge-dialog">
        <PrDialogHeading
          badge={
            <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-cf-success-surface text-cf-success-text" aria-hidden>
              <GitMerge className="size-4" />
            </span>
          }
          heading={MERGE_BUTTON_LABELS[method]}
          slug={prRef.slug}
          number={prRef.number}
          prTitle={pr.title}
          testId="pr-merge-dialog"
        />
        <div className="mt-3 divide-y divide-cf-border rounded-lg border border-cf-border" data-testid="pr-merge-dialog-summary">
          <Row label="Into" testId="pr-merge-dialog-into">
            <span className="min-w-0 truncate text-code">{pr.baseRef}</span>
            <span className="ml-auto shrink-0 text-caption" data-testid="pr-merge-dialog-outcome">
              {mergeOutcome(method, detail.commitCount)}
            </span>
          </Row>
          <Row label="From" testId="pr-merge-dialog-from">
            <span className="min-w-0 text-code [overflow-wrap:anywhere]">{pr.headRef}</span>
          </Row>
          <Row label="Method" testId="pr-merge-dialog-method">
            <RadioGroup
              variant="segmented"
              size="sm"
              aria-label="Merge method"
              value={method}
              onValueChange={(v) => {
                const m = methods.find((x) => x === v);
                if (m) onMethod(m);
              }}
              className="flex-wrap"
            >
              {methods.map((m) => (
                <RadioGroupChoice key={m} value={m} data-testid={`pr-merge-dialog-method-${m}`}>
                  {MERGE_SHORT_LABELS[m]}
                </RadioGroupChoice>
              ))}
            </RadioGroup>
          </Row>
          {deletable && (
            <Row label="Branch" testId="pr-merge-dialog-branch">
              <Checkbox
                id={deleteId}
                checked={deleteBranch}
                onCheckedChange={(v) => {
                  onDeleteBranch(v === true);
                }}
                data-testid="pr-merge-dialog-delete-branch"
              />
              <label htmlFor={deleteId} className="text-label">
                Delete it on GitHub after merging
              </label>
            </Row>
          )}
        </div>
        {reason && (
          <p className="mt-3 text-caption text-cf-warning-text" data-testid="pr-merge-dialog-reason">
            {reason}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              onOpenChange(false);
            }}
            data-testid="pr-merge-dialog-cancel"
          >
            Cancel
          </Button>
          <Button size="sm" autoFocus disabled={reason !== null} className={cn(successButton)} onClick={onConfirm} data-testid="pr-merge-dialog-confirm">
            <GitMerge aria-hidden />
            {MERGE_BUTTON_LABELS[method]}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
