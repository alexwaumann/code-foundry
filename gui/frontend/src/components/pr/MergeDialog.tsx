import { GitMerge } from "lucide-react";
import { useId } from "react";
import type { MergeMethodView, PullRequestDetailView } from "@/api/gh";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { MERGE_BUTTON_LABELS, MERGE_SHORT_LABELS, mergeOutcome } from "./merge";

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
 * with the method and the number over the pull request's title. Its rows say where it
 * merges (and what the method does to the commits), from which branch, how (the methods
 * the repository allows; a pick there is the repository's default at once, as in the
 * menu), and whether origin's branch goes (only when it can). `reason`, when set, is why
 * GitHub would refuse now (the pull request changed while it was open): said, and the
 * confirm is off. Confirm has the focus: Enter merges, Escape cancels.
 */
export function MergeDialog({
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
        <div className="flex items-center gap-3">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-cf-success-surface text-cf-success-text" aria-hidden>
            <GitMerge className="size-4" />
          </span>
          <div className="flex min-w-0 flex-col">
            <DialogTitle data-testid="pr-merge-dialog-title">
              {MERGE_BUTTON_LABELS[method]} #{pr.number}
            </DialogTitle>
            <Tip label={pr.title} whenTruncated>
              <DialogDescription className="truncate" data-testid="pr-merge-dialog-pr-title">
                {pr.title}
              </DialogDescription>
            </Tip>
          </div>
        </div>
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
                Delete it on origin after merging
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
