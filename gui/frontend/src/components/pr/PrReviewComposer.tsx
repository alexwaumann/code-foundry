import { useState } from "react";
import { pullRequestKey } from "@/stores/gh";
import { submitReview, usePrPanelStore } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { PanelComposer } from "./PanelComposer";
import { canSubmit, composerHint, VERDICT_SPECS, type Verdict } from "./review";
import { verdictIcons } from "./reviewIcons";
import { toneText } from "./tones";

/** The submit button per verdict: the verdict's tone (Approve green, Request changes red, Comment the primary button). */
const submitClass: Record<Verdict, string> = {
  approve: "border border-success/40 bg-success/10 text-success enabled:hover:bg-success/15",
  "request-changes": "border border-destructive/40 bg-destructive/10 text-destructive enabled:hover:bg-destructive/15",
  comment: "bg-primary text-primary-foreground enabled:hover:bg-primary/90",
};

/**
 * Review ▾ → a verdict: an inline composer under the PR header (PanelComposer), in the
 * ask composer's slot (the surface shows one or the other). Cmd+Enter submits through
 * pr.review (submitReview); Enter is a newline (reviews run to several lines); Escape
 * cancels. Approve takes an optional note; Request changes and Comment wait for text,
 * and the hint says so. Choosing another verdict while it is open changes the label and
 * keeps the text. While it submits the field is read-only, the submit button spins and
 * the composer cannot be cancelled; success closes it, handing focus to the panel, once
 * the detail shows the review. A failure is toasted (GitHub's message) and the text
 * stays. While another surface submits a review of the same pull request, the button
 * shows that spinner and the hint says so; the text stays editable.
 *
 * focusRequest: bumped by the surface each time a verdict is chosen, so choosing one
 * with the composer open moves focus back into it.
 */
export function PrReviewComposer({ prRef, verdict, focusRequest, onClose }: { prRef: PrRef; verdict: Verdict; focusRequest: number; onClose: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const busy = usePrPanelStore((s) => s.reviewing[pullRequestKey(prRef.slug, prRef.number)] ?? false);
  const elsewhere = busy && !sending;
  const spec = VERDICT_SPECS[verdict];
  const ready = canSubmit(verdict, text);
  const Icon = verdictIcons[verdict].icon;

  const send = async (): Promise<boolean> => {
    if (sending || !ready) return false;
    // Another surface's review of this pull request: submitReview would send nothing.
    if (usePrPanelStore.getState().reviewing[pullRequestKey(prRef.slug, prRef.number)]) return false;
    setSending(true);
    try {
      return await submitReview(prRef, verdict, text);
    } finally {
      setSending(false);
    }
  };

  return (
    <PanelComposer
      ariaLabel={spec.label(prRef.number)}
      className={verdict === "approve" ? "bg-success/5" : undefined}
      label={
        <>
          <Icon className="size-3.5" aria-hidden />
          {spec.label(prRef.number)}
        </>
      }
      labelClassName={spec.tone === "neutral" ? undefined : toneText[spec.tone]}
      text={text}
      onTextChange={setText}
      placeholder={spec.placeholder}
      hint={composerHint(verdict, text, sending, elsewhere)}
      hintIsStatus={elsewhere || sending}
      submitKey="cmd-enter"
      submit={{
        label: spec.title,
        ariaLabel: `${spec.title} #${String(prRef.number)}`,
        icon: verdictIcons[verdict].button,
        className: submitClass[verdict],
        disabled: busy || !ready,
        busy,
      }}
      onSubmit={send}
      locked={sending}
      focusRequest={focusRequest}
      onClose={onClose}
      testIds={{ root: "pr-review-composer", label: "pr-review-label", input: "pr-review-input", hint: "pr-review-hint", cancel: "pr-review-cancel", submit: "pr-review-submit" }}
      dataAttrs={{ "data-verdict": verdict }}
    />
  );
}
