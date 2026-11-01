import { ChevronDown, Eye, Loader2 } from "lucide-react";
import { useRef, useState } from "react";
import type { PullRequestDetailView } from "@/api/gh";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { pullRequestKey, useViewerLogin } from "@/stores/gh";
import { usePrPanelStore } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { POPUP_COLLISION_PADDING, POPUP_FIT, stopPlainKeys, usePanelBoundary } from "./keys";
import { Item } from "./PrMenu";
import { disabledVerdicts, reviewVisible, VERDICT_SPECS, VERDICTS, YOUR_REVIEW_SPECS, yourReview, type Verdict } from "./review";
import { yourReviewIcon } from "./reviewIcons";
import { toneBadge } from "./tones";


/**
 * The header's Review ▾, left of Merge: a menu of Approve, Request changes and Comment.
 * Choosing one opens the surface's review composer with that verdict (onChoose); focus
 * goes there, not back to this button. On the viewer's own pull request Approve and
 * Request changes are disabled (GitHub refuses them), with the reason as a tooltip.
 * Once the viewer has reviewed, the button is a chip saying so ("You approved"), still
 * opening the menu: GitHub takes another review. Shown only on open pull requests the
 * viewer can write to (like the reviewer picker); below 340px only the icons stay.
 */
export function ReviewButton({ prRef, detail, onChoose }: { prRef: PrRef; detail: PullRequestDetailView; onChoose: (v: Verdict) => void }) {
  const viewer = useViewerLogin();
  const busy = usePrPanelStore((s) => s.reviewing[pullRequestKey(prRef.slug, prRef.number)] ?? false);
  const [open, setOpen] = useState(false);
  // A review starting (here or on another surface showing this pull request) shuts the
  // menu for good: the controlled `open && !busy` alone would leave `open` set, and the
  // menu would pop back once the review settles. Derived during render (React's
  // "adjusting state when a prop changes"), as an effect's setState trips the lint.
  const [wasBusy, setWasBusy] = useState(busy);
  if (busy !== wasBusy) {
    setWasBusy(busy);
    if (busy) setOpen(false);
  }
  const { ref, boundary } = usePanelBoundary();
  // A chosen verdict hands focus to the composer, so the menu must not take it back.
  const keepFocus = useRef(false);
  if (!reviewVisible(detail)) return null;
  const mine = yourReview(detail.reviewers, viewer);
  const disabled = disabledVerdicts(detail.pullRequest.author, viewer);
  const Icon = mine ? yourReviewIcon[mine] : Eye;
  return (
    <DropdownMenu
      modal={false}
      open={open && !busy}
      onOpenChange={(next) => {
        // While a review is being submitted the menu stays shut (its composer is busy).
        if (!next || !busy) setOpen(next);
        if (next) keepFocus.current = false;
      }}
    >
      <DropdownMenuTrigger asChild>
        <button
          ref={ref}
          type="button"
          data-testid={mine ? "pr-your-review" : "pr-review-button"}
          data-review={mine ?? undefined}
          aria-disabled={busy || undefined}
          aria-busy={busy || undefined}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1 rounded-md border text-label shadow-xs outline-none focus-visible:ring-2 focus-visible:ring-cf-focus/60",
            mine
              ? cn("px-2 @max-[340px]:px-1.5", toneBadge[YOUR_REVIEW_SPECS[mine].tone], "hover:brightness-110 aria-expanded:brightness-110")
              : "bg-cf-canvas pr-1.5 pl-2 hover:bg-cf-control-hover aria-expanded:bg-cf-control-hover @max-[340px]:pl-1.5 dark:border-cf-input dark:bg-cf-input/30 dark:hover:bg-cf-input/50 dark:aria-expanded:bg-cf-input/50",
            busy && "cursor-default",
          )}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <Icon className="size-3.5" aria-hidden />}
          <span className="whitespace-nowrap @max-[340px]:sr-only">{mine ? YOUR_REVIEW_SPECS[mine].label : "Review"}</span>
          {!mine && <ChevronDown className="size-3.5 opacity-70" aria-hidden />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        collisionBoundary={boundary}
        collisionPadding={POPUP_COLLISION_PADDING}
        className={cn("w-80", POPUP_FIT)}
        data-testid="pr-review-menu"
        data-region="panel"
        onKeyDown={stopPlainKeys}
        onCloseAutoFocus={(e) => {
          if (!keepFocus.current) return;
          keepFocus.current = false;
          e.preventDefault();
        }}
      >
        <DropdownMenuLabel>Review #{prRef.number}</DropdownMenuLabel>
        {VERDICTS.map((v) => {
          const spec = VERDICT_SPECS[v];
          const reason = disabled[v];
          const item = (
            <DropdownMenuItem
              key={v}
              data-testid={`pr-review-${v}`}
              disabled={reason !== undefined}
              onSelect={() => {
                keepFocus.current = true;
                onChoose(v);
              }}
            >
              <Item title={spec.title} hint={spec.hint} />
            </DropdownMenuItem>
          );
          // Disabled: the reason hangs on a span around it (a disabled item gets no pointer events).
          return reason === undefined ? (
            item
          ) : (
            <Tip key={v} label={reason} side="left">
              <span className="grid" data-testid={`pr-review-${v}-reason`}>
                {item}
              </span>
            </Tip>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
