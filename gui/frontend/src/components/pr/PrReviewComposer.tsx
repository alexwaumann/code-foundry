import { Check, CircleX, Loader2, MessageSquare } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { pullRequestKey } from "@/stores/gh";
import { submitReview, usePrPanelStore } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { composerKeyAction } from "./keys";
import { verdictIcon } from "./reviewIcons";
import { canSubmit, composerHint, VERDICT_SPECS, type Verdict } from "./review";
import { toneText } from "./tones";

/** The submit button per verdict: the verdict's tone (Approve green, Request changes red, Comment the primary button). */
const submitClass: Record<Verdict, string> = {
  approve: "border border-success/40 bg-success/10 text-success enabled:hover:bg-success/15",
  "request-changes": "border border-destructive/40 bg-destructive/10 text-destructive enabled:hover:bg-destructive/15",
  comment: "bg-primary text-primary-foreground enabled:hover:bg-primary/90",
};
const submitIcon: Record<Verdict, typeof Check> = { approve: Check, "request-changes": CircleX, comment: MessageSquare };

/** Sizes the textarea to its text, from its 3 rows up to its max-height (6 rows), past which it scrolls. */
function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${String(el.scrollHeight + el.offsetHeight - el.clientHeight)}px`;
}

/**
 * Review ▾ → a verdict: an inline composer under the PR header, in the ask composer's
 * slot (the surface shows one or the other). Cmd+Enter submits through pr.review
 * (submitReview); Enter is a newline (reviews run to several lines); Escape cancels.
 * Approve takes an optional note; Request changes and Comment wait for text, and the hint
 * says so. Choosing another verdict while it is open changes the label and keeps the
 * text. While it submits the field is read-only, the submit button spins and the composer
 * cannot be cancelled; success closes it, handing focus to the panel, once the detail
 * shows the review. A failure is toasted (GitHub's message) and the text stays.
 *
 * focusRequest: bumped by the surface each time a verdict is chosen, so choosing one
 * with the composer open moves focus back into it.
 */
export function PrReviewComposer({ prRef, verdict, focusRequest, onClose }: { prRef: PrRef; verdict: Verdict; focusRequest: number; onClose: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  // Another surface showing this pull request is submitting a review.
  const busy = usePrPanelStore((s) => s.reviewing[pullRequestKey(prRef.slug, prRef.number)] ?? false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const spec = VERDICT_SPECS[verdict];
  const ready = canSubmit(verdict, text);
  const Icon = verdictIcon[verdict];
  const SubmitIcon = submitIcon[verdict];
  const n = String(prRef.number);

  // After the menu closes (it does not take focus back to its button for these items).
  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => {
      cancelAnimationFrame(id);
    };
  }, [focusRequest]);

  useLayoutEffect(() => {
    if (ref.current) fitHeight(ref.current);
  }, [text]);

  /** Closes, handing focus to the panel so its keys keep working. */
  const close = () => {
    const panel = ref.current?.closest<HTMLElement>('[data-region="panel"]');
    onClose();
    panel?.focus();
  };

  const send = async () => {
    if (sending || busy || !ready) return;
    setSending(true);
    try {
      if (await submitReview(prRef, verdict, text)) close();
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKeyAction(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        isComposing: e.nativeEvent.isComposing,
        // Deprecated, but the only sign of WebKit's IME-confirming Enter (keys.ts).
        // eslint-disable-next-line @typescript-eslint/no-deprecated
        keyCode: e.nativeEvent.keyCode,
      },
      "cmd-enter",
    );
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === "send") void send();
    // Escape while submitting does nothing: the review is posted either way.
    else if (!sending) close();
  };

  return (
    <section
      className={cn("flex flex-col gap-2 border-b border-pane-border px-4 py-3 @max-[340px]:px-3", verdict === "approve" && "bg-success/5")}
      aria-label={spec.label(prRef.number)}
      data-testid="pr-review-composer"
      data-verdict={verdict}
    >
      <Label htmlFor="pr-review-input" className={cn("gap-1.5 text-xs", spec.tone === "neutral" ? "text-muted-foreground" : toneText[spec.tone])} data-testid="pr-review-label">
        <Icon className="size-3.5" aria-hidden />
        {spec.label(prRef.number)}
      </Label>
      <Textarea
        id="pr-review-input"
        ref={ref}
        rows={3}
        value={text}
        readOnly={sending}
        placeholder={spec.placeholder}
        aria-describedby="pr-review-hint"
        className="max-h-[calc(6lh+1rem+2px)] min-h-0 resize-none overflow-y-auto text-[13px] leading-snug read-only:opacity-70"
        data-testid="pr-review-input"
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="flex min-w-0 items-center gap-2">
        <Tip label={composerHint(verdict, text, sending)} whenTruncated align="start">
          <span id="pr-review-hint" className="min-w-0 truncate text-xs text-muted-foreground" role="status" data-testid="pr-review-hint">
            {composerHint(verdict, text, sending)}
          </span>
        </Tip>
        <button
          type="button"
          disabled={sending}
          className="ml-auto shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:hover:bg-transparent"
          data-testid="pr-review-cancel"
          onClick={close}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !ready}
          aria-busy={busy || undefined}
          aria-label={`${spec.title} #${n}`}
          className={cn(
            "flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-xs font-medium whitespace-nowrap outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50",
            submitClass[verdict],
          )}
          data-testid="pr-review-submit"
          onClick={() => void send()}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <SubmitIcon className="size-3.5" aria-hidden />}
          {spec.title}
        </button>
      </div>
    </section>
  );
}
