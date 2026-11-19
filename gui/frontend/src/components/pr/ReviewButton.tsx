import { Eye, Loader2 } from "lucide-react";
import type { PullRequestDetailView } from "@/api/gh";
import { cn } from "@/lib/utils";
import { pullRequestDetailResource, pullRequestKey, useViewerLogin } from "@/stores/gh";
import { useReviewingVerdict } from "@/stores/prPanel";
import { draftVerdict, openReviewDialog } from "@/stores/reviewDialog";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { disabledVerdicts, initialVerdict, reviewRequested, reviewVisible, VERDICT_SPECS, YOUR_REVIEW_SPECS, yourReview } from "./review";
import { yourReviewIcon } from "./reviewIcons";
import { toneBadge } from "./tones";

const sizes = {
  default: "h-7 gap-1 px-2 text-label",
  sm: "h-6 gap-1 px-1.5 text-body-sm",
} as const;

/**
 * The pull request's Review: pressing it opens the review dialog (ReviewDialog, one for the
 * window) on the verdict initialVerdict picks. Once the viewer has reviewed, it is a chip
 * saying so ("You approved"), which opens the dialog again on that verdict: GitHub takes
 * another review. `primary` (the viewer's review is requested, again too) makes it the
 * primary button, saying Review. While a review of this pull request is submitted it is
 * busy in the verdict's words ("Approving…") and opens nothing. Shown only on open pull
 * requests the viewer can write to or is asked to review (reviewVisible). `size` "sm" is
 * the Diff tab's bar.
 */
export function ReviewButton({ prRef, detail, primary = false, size = "default" }: { prRef: PrRef; detail: PullRequestDetailView; primary?: boolean; size?: keyof typeof sizes }) {
  const viewer = useViewerLogin();
  const busy = useReviewingVerdict(prRef);
  if (!reviewVisible(detail, viewer)) return null;
  const mine = primary ? null : yourReview(detail.reviewers, viewer);
  const Icon = mine ? yourReviewIcon[mine] : Eye;
  return (
    <button
      type="button"
      data-testid={mine ? "pr-your-review" : "pr-review-button"}
      data-review={mine ?? undefined}
      data-primary={primary || undefined}
      data-size={size}
      aria-haspopup="dialog"
      aria-disabled={busy !== null || undefined}
      aria-busy={busy !== null || undefined}
      className={cn(
        "flex shrink-0 items-center justify-center rounded-md border shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-cf-focus/60",
        sizes[size],
        busy !== null
          ? "cursor-default bg-cf-canvas text-cf-text-muted dark:border-cf-input dark:bg-cf-input/30"
          : mine
            ? cn(toneBadge[YOUR_REVIEW_SPECS[mine].tone], "hover:brightness-110")
            : primary
              ? "border-transparent bg-cf-accent text-cf-accent-foreground hover:bg-cf-accent/90"
              : "bg-cf-canvas hover:bg-cf-control-hover dark:border-cf-input dark:bg-cf-input/30 dark:hover:bg-cf-input/50",
      )}
      onClick={(e) => {
        if (busy !== null) return;
        openReviewDialog(prRef, initialVerdict(draftVerdict(prRef), mine, disabledVerdicts(detail.pullRequest.author, viewer)), e.currentTarget);
      }}
    >
      {busy !== null ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Icon className="size-3.5" aria-hidden />}
      <span className="whitespace-nowrap">{busy !== null ? VERDICT_SPECS[busy].busy : mine ? YOUR_REVIEW_SPECS[mine].label : "Review"}</span>
    </button>
  );
}

/**
 * The Diff tab's Review (PrDiffView's review slot): the same button for the pull request,
 * smaller for the bar, once its detail is here; primary when the viewer's review is
 * requested, as in the header.
 */
export function PrDiffReviewButton({ prRef }: { prRef: PrRef }) {
  const viewer = useViewerLogin();
  const detail = pullRequestDetailResource.store((s) => s.entries[pullRequestKey(prRef.slug, prRef.number)]?.data ?? null);
  if (!detail) return null;
  return <ReviewButton prRef={prRef} detail={detail} primary={reviewRequested(detail.reviewers, viewer)} size="sm" />;
}
