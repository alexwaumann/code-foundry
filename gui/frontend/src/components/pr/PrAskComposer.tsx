import { CornerDownLeft, MessageCircleQuestion } from "lucide-react";
import { useState } from "react";
import { startingKey, startPrThread, usePrThreadsStore } from "@/stores/prThreads";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { PanelComposer } from "./PanelComposer";

/** The hint while nothing runs: narrow enough for a 280px panel. */
export const ASK_KEYS_HINT = "⏎ send · ⇧⏎ newline";
/** The hint while this composer's pr.ask runs. */
export const ASK_SENDING_HINT = "Starting a thread…";
/** The hint while pr.ask for the same pull request runs from another surface. */
export const ASK_ELSEWHERE_HINT = "Already starting a thread for this pull request";

/**
 * Menu → Ask a question: an inline composer under the PR header (PanelComposer). Enter
 * sends the question through pr.ask (startPrThread), Shift+Enter is a newline, Escape
 * cancels. While its command runs the field is read-only and the composer cannot be
 * cancelled (the thread starts either way); on success the daemon focuses the new
 * thread and the composer closes, handing focus to the panel. A failure is toasted and
 * the text stays. While pr.ask for the same pull request runs from another surface, the
 * Ask button shows that spinner and the hint says so; the text stays editable.
 *
 * focusRequest: bumped by the surface each time Ask a question is chosen, so choosing it
 * again with the composer open moves focus back into it.
 */
export function PrAskComposer({ prRef, focusRequest, onClose }: { prRef: PrRef; focusRequest: number; onClose: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const busy = usePrThreadsStore((s) => s.starting[startingKey(prRef, "ask")] ?? false);
  const elsewhere = busy && !sending;

  const send = async (): Promise<boolean> => {
    if (sending || !text.trim()) return false;
    // Another surface's pr.ask for this pull request: startPrThread would send nothing.
    if (usePrThreadsStore.getState().starting[startingKey(prRef, "ask")]) return false;
    setSending(true);
    try {
      return (await startPrThread("ask", prRef, text)) !== null;
    } finally {
      setSending(false);
    }
  };

  return (
    <PanelComposer
      ariaLabel={`Ask about #${String(prRef.number)}`}
      label={
        <>
          <MessageCircleQuestion className="size-3.5" aria-hidden />
          Ask about #{prRef.number}
        </>
      }
      text={text}
      onTextChange={setText}
      placeholder="Ask about this pull request…"
      hint={sending ? ASK_SENDING_HINT : elsewhere ? ASK_ELSEWHERE_HINT : ASK_KEYS_HINT}
      hintIsStatus={elsewhere}
      submitKey="enter"
      submit={{
        label: "Ask",
        icon: CornerDownLeft,
        className: "bg-primary text-primary-foreground enabled:hover:bg-primary/90",
        disabled: busy || !text.trim(),
        busy,
      }}
      onSubmit={send}
      locked={sending}
      focusRequest={focusRequest}
      onClose={onClose}
      testIds={{ root: "pr-ask", input: "pr-ask-input", hint: "pr-ask-hint", cancel: "pr-ask-cancel", submit: "pr-ask-send" }}
    />
  );
}
