import { Check, CircleX, Eye, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from "react";
import type { PullRequestDetailView } from "@/api/gh";
import { DictationMic, DictationNote } from "@/components/compose/DictationMic";
import { useComposerDictation } from "@/components/compose/useComposerDictation";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { RadioGroup, RadioGroupChoice } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { Tip } from "@/components/ui/tooltip";
import { LISTENING_PLACEHOLDER, phraseAtCaret } from "@/lib/dictation";
import { cn } from "@/lib/utils";
import { focusPaneOf } from "@/shell/paneBox";
import { pullRequestDetailResource, pullRequestKey, useViewerLogin } from "@/stores/gh";
import { submitReview, usePrPanelStore } from "@/stores/prPanel";
import { clearReviewDraft, closeReviewDialog, setReviewDraft, useReviewDialogStore, type ReviewDraft } from "@/stores/reviewDialog";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { composerKeyAction } from "./keys";
import { PrDialogHeading } from "./PrDialogHeading";
import { canSubmit, disabledVerdicts, OWN_PULL_REQUEST_NOTE, reviewHint, reviewVisible, VERDICT_SPECS, VERDICTS, type Verdict } from "./review";
import { verdictIcons } from "./reviewIcons";
import { statusPill } from "./tones";

/** The badge per verdict: its icon in the verdict's tone (Comment the review's eye, quiet). */
const badge: Record<Verdict, { icon: LucideIcon; className: string }> = {
  approve: { icon: Check, className: statusPill.success },
  "request-changes": { icon: CircleX, className: statusPill.error },
  comment: { icon: Eye, className: statusPill.neutral },
};

/**
 * The confirm per verdict: Approve the success fill (as the merge dialog's), Request changes
 * the error tone as text and an outline (never a filled destructive button), Comment the
 * primary button.
 */
const confirmClass: Record<Verdict, string> = {
  approve: "bg-cf-success text-cf-success-foreground hover:bg-cf-success/90",
  "request-changes": "border border-cf-error/40 bg-cf-error-surface text-cf-error-text hover:bg-cf-error/15",
  comment: "",
};

const EMPTY: ReviewDraft = { verdict: "comment", text: "" };

/**
 * The review dialog, one for the window (mounted in App), open for the pull request in
 * stores/reviewDialog.ts: the verdict's icon in its tone, "Review" over owner/repo #number
 * and the pull request's title (PrDialogHeading), a segmented Comment | Approve | Request
 * changes, a comment box, Cancel and a confirm in the verdict's words and tone. On the
 * viewer's own pull request Approve and Request changes are off and one line says why. The comment box has the focus; cmd+Enter
 * submits, Escape cancels (stopping dictation first). Submitting shuts the dialog and runs
 * pr.review (submitReview), the Review button busy until the detail shows the review; the
 * text lives in the store's draft, so a refusal (toasted) loses nothing. It shuts by itself
 * when the pull request stops taking reviews or its detail goes.
 */
export function ReviewDialog() {
  const open = useReviewDialogStore((s) => s.open);
  const key = open ? pullRequestKey(open.slug, open.number) : "";
  const detail = pullRequestDetailResource.store((s) => (key ? (s.entries[key]?.data ?? null) : null));
  const viewer = useViewerLogin();
  const busy = usePrPanelStore((s) => (key ? s.reviewing[key] !== undefined : false));
  const shown = open !== null && detail !== null && reviewVisible(detail, viewer) && !busy;
  // Open with nothing to show (merged meanwhile, the tab closed and its detail gone): shut,
  // so a page's guarded question is not left waiting behind it.
  useEffect(() => {
    if (open !== null && !shown) closeReviewDialog();
  }, [open, shown]);
  return (
    <Dialog
      open={shown}
      onOpenChange={(next) => {
        if (!next) closeReviewDialog();
      }}
    >
      {shown && <ReviewDialogBody key={key} prRef={open} detail={detail} viewer={viewer} />}
    </Dialog>
  );
}

function ReviewDialogBody({ prRef, detail, viewer }: { prRef: PrRef; detail: PullRequestDetailView; viewer: string }) {
  const key = pullRequestKey(prRef.slug, prRef.number);
  const draft = useReviewDialogStore((s) => s.drafts[key] ?? EMPTY);
  const { verdict, text } = draft;
  const disabled = disabledVerdicts(detail.pullRequest.author, viewer);
  const spec = VERDICT_SPECS[verdict];
  const ready = canSubmit(verdict, text);
  const pr = detail.pullRequest;
  const field = useRef<HTMLTextAreaElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const caretAfter = useRef<number | null>(null);
  const sending = useRef(false);
  const dictation = useComposerDictation({
    draftKey: "pr-review-dialog",
    rootRef,
    primary: false,
    insert: (phrase) => {
      const el = field.current;
      const value = useReviewDialogStore.getState().drafts[key]?.text ?? "";
      const mine = el !== null && document.activeElement === el;
      const start = mine ? el.selectionStart : value.length;
      const end = mine ? el.selectionEnd : value.length;
      const lineStart = value.lastIndexOf("\n", start - 1) + 1;
      const nl = value.indexOf("\n", end);
      const ins = phraseAtCaret(phrase, value.slice(lineStart, start), value.slice(end, nl === -1 ? undefined : nl));
      if (ins === "") return;
      caretAfter.current = start + ins.length;
      setReviewDraft(prRef, { text: value.slice(0, start) + ins + value.slice(end) });
    },
  });
  useLayoutEffect(() => {
    const el = field.current;
    if (el) {
      // Grows with the text (border-box) up to its max-height, then scrolls.
      el.style.height = "auto";
      el.style.height = `${String(el.scrollHeight + el.offsetHeight - el.clientHeight)}px`;
    }
    const at = caretAfter.current;
    caretAfter.current = null;
    if (at !== null && field.current && document.activeElement === field.current) field.current.setSelectionRange(at, at);
  }, [text]);

  const submit = async () => {
    if (sending.current) return;
    sending.current = true;
    try {
      if (dictation.phase) {
        // Dictating: stop, let the last phrase land, then submit the text it made.
        await dictation.flush();
        await new Promise((r) => setTimeout(r, 0));
      }
      const now = useReviewDialogStore.getState().drafts[key] ?? EMPTY;
      if (!canSubmit(now.verdict, now.text) || disabled.includes(now.verdict) || usePrPanelStore.getState().reviewing[key] !== undefined) return;
      closeReviewDialog();
      if (await submitReview(prRef, now.verdict, now.text)) clearReviewDraft(prRef);
    } finally {
      sending.current = false;
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter") return;
    const action = composerKeyAction(
      {
        key: e.key,
        shiftKey: e.shiftKey,
        metaKey: e.metaKey,
        ctrlKey: e.ctrlKey,
        altKey: e.altKey,
        isComposing: e.nativeEvent.isComposing,
        // Deprecated, but the only sign of WebKit's IME-confirming Enter (keys.ts).
        // oxlint-disable-next-line typescript/no-deprecated
        keyCode: e.nativeEvent.keyCode,
      },
      "cmd-enter",
    );
    if (action !== "send") return;
    e.preventDefault();
    e.stopPropagation();
    void submit();
  };

  const Badge = badge[verdict].icon;
  const ConfirmIcon = verdictIcons[verdict].button;
  return (
    <DialogContent
      ref={rootRef}
      className="max-w-md p-5"
      data-testid="pr-review-dialog"
      data-verdict={verdict}
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        const el = field.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }}
      onCloseAutoFocus={(e) => {
        // Back to the button that opened it (busy now, or the chip), else its pane, so the pane's keys keep working.
        const opener = useReviewDialogStore.getState().opener;
        if (!opener) return;
        e.preventDefault();
        if (opener.isConnected) opener.focus();
        else focusPaneOf(rootRef.current);
      }}
      onEscapeKeyDown={(e) => {
        // Escape confirming an IME's text, or stopping dictation, is only that.
        if (e.isComposing || dictation.onEscape()) e.preventDefault();
      }}
      onKeyDown={onKeyDown}
    >
      <PrDialogHeading
        badge={
          <span className={cn("flex size-8 shrink-0 items-center justify-center rounded-full", badge[verdict].className)} data-testid="pr-review-dialog-badge" aria-hidden>
            <Badge className="size-4" />
          </span>
        }
        heading="Review"
        slug={prRef.slug}
        number={prRef.number}
        prTitle={pr.title}
        testId="pr-review-dialog"
      />
      <div className="mt-3 flex flex-col gap-1.5">
        <RadioGroup
          variant="segmented"
          size="sm"
          aria-label="Verdict"
          value={verdict}
          onValueChange={(v) => {
            const next = VERDICTS.find((x) => x === v);
            if (next) setReviewDraft(prRef, { verdict: next });
          }}
          className="flex-wrap"
        >
          {VERDICTS.map((v) => (
            <RadioGroupChoice key={v} value={v} disabled={disabled.includes(v)} data-testid={`pr-review-dialog-${v}`}>
              {VERDICT_SPECS[v].title}
            </RadioGroupChoice>
          ))}
        </RadioGroup>
        {disabled.length > 0 && (
          <p className="text-caption" data-testid="pr-review-dialog-own">
            {OWN_PULL_REQUEST_NOTE}
          </p>
        )}
      </div>
      <Textarea
        ref={field}
        rows={4}
        value={text}
        aria-label="Review comment"
        aria-describedby="pr-review-dialog-hint"
        placeholder={dictation.listening ? LISTENING_PLACEHOLDER : spec.placeholder}
        className="mt-3 max-h-[calc(10lh+1rem+2px)] min-h-0 resize-none overflow-y-auto text-body-sm"
        data-testid="pr-review-dialog-input"
        onChange={(e) => {
          setReviewDraft(prRef, { text: e.target.value });
        }}
      />
      <div className="mt-4 flex min-w-0 items-center gap-2">
        <Tip label={reviewHint(verdict, text)} whenTruncated align="start">
          <span id="pr-review-dialog-hint" className="min-w-0 truncate text-caption-sm" data-testid="pr-review-dialog-hint">
            {reviewHint(verdict, text)}
          </span>
        </Tip>
        <DictationMic dictation={dictation} className="ml-auto" />
        <Button variant="ghost" size="sm" className={cn(dictation.availability === "hidden" && !dictation.phase && "ml-auto")} onClick={closeReviewDialog} data-testid="pr-review-dialog-cancel">
          Cancel
        </Button>
        <Button
          size="sm"
          disabled={!ready && !dictation.listening}
          className={confirmClass[verdict]}
          aria-label={`${spec.confirm} #${String(pr.number)}`}
          onClick={() => void submit()}
          data-testid="pr-review-dialog-confirm"
        >
          <ConfirmIcon aria-hidden />
          {spec.confirm}
        </Button>
      </div>
      <DictationNote dictation={dictation} className="mt-2" />
    </DialogContent>
  );
}
