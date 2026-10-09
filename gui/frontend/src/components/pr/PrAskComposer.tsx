import { CornerDownLeft, Loader2, MessageCircleQuestion } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { startingKey, startPrSession, usePrSessionsStore } from "@/stores/prSessions";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { composerKeyAction } from "./keys";

/** The hint while nothing runs: narrow enough for a 280px panel. */
export const ASK_KEYS_HINT = "⏎ send · ⇧⏎ newline";
/** The hint while this composer's pr.ask runs. */
export const ASK_SENDING_HINT = "Starting a session…";
/** The hint while pr.ask for the same pull request runs from another surface. */
export const ASK_ELSEWHERE_HINT = "Already starting a thread for this pull request";

/**
 * Sizes the textarea to its text, from its 3 rows up to its max-height (6 rows), past
 * which it scrolls. Height includes the border (border-box).
 */
function fitHeight(el: HTMLTextAreaElement): void {
  el.style.height = "auto";
  el.style.height = `${String(el.scrollHeight + el.offsetHeight - el.clientHeight)}px`;
}

/**
 * Menu → Ask a question: an inline composer under the PR header. Enter sends the question
 * through pr.ask (startPrSession), Shift+Enter is a newline, Escape cancels. While its
 * command runs the field is read-only and the composer cannot be cancelled (the session
 * starts either way); on success the daemon focuses the new session and the composer
 * closes, handing focus to the panel. A failure is toasted and the text stays. While
 * pr.ask for the same pull request runs from another surface, the Ask button shows that
 * spinner and the hint says so; the text stays editable.
 *
 * focusRequest: bumped by the surface each time Ask a question is chosen, so choosing it
 * again with the composer open moves focus back into it.
 */
export function PrAskComposer({ prRef, focusRequest, onClose }: { prRef: PrRef; focusRequest: number; onClose: () => void }) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const busy = usePrSessionsStore((s) => s.starting[startingKey(prRef, "ask")] ?? false);
  const elsewhere = busy && !sending;
  const ref = useRef<HTMLTextAreaElement>(null);

  // After the menu closes (it does not take focus back to its button for this item).
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
    if (sending || !text.trim()) return;
    // Another surface's pr.ask for this pull request: startPrSession would send nothing.
    if (usePrSessionsStore.getState().starting[startingKey(prRef, "ask")]) return;
    setSending(true);
    try {
      if ((await startPrSession("ask", prRef, text)) !== null) close();
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const action = composerKeyAction({
      key: e.key,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      isComposing: e.nativeEvent.isComposing,
      // Deprecated, but the only sign of WebKit's IME-confirming Enter (keys.ts).
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      keyCode: e.nativeEvent.keyCode,
    });
    if (!action) return;
    e.preventDefault();
    e.stopPropagation();
    if (action === "send") void send();
    // Escape while sending does nothing: the session starts anyway.
    else if (!sending) close();
  };

  return (
    <section className="flex flex-col gap-2 border-b border-pane-border px-4 py-3 @max-[340px]:px-3" aria-label={`Ask about #${String(prRef.number)}`} data-testid="pr-ask">
      <label htmlFor="pr-ask-input" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <MessageCircleQuestion className="size-3.5" aria-hidden />
        Ask about #{prRef.number}
      </label>
      <textarea
        id="pr-ask-input"
        ref={ref}
        rows={3}
        value={text}
        readOnly={sending}
        placeholder="Ask about this pull request…"
        className="max-h-[calc(6lh+1rem+2px)] w-full resize-none overflow-y-auto rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] leading-snug outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring read-only:opacity-70"
        data-testid="pr-ask-input"
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="min-w-0 truncate text-xs text-muted-foreground"
          title={elsewhere ? ASK_ELSEWHERE_HINT : undefined}
          role={elsewhere ? "status" : undefined}
          data-testid="pr-ask-hint"
        >
          {sending ? ASK_SENDING_HINT : elsewhere ? ASK_ELSEWHERE_HINT : ASK_KEYS_HINT}
        </span>
        <button
          type="button"
          disabled={sending}
          className="ml-auto shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50 disabled:hover:bg-transparent"
          data-testid="pr-ask-cancel"
          onClick={close}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !text.trim()}
          aria-busy={busy || undefined}
          className="flex shrink-0 items-center gap-1 rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground outline-none hover:bg-primary/90 focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
          data-testid="pr-ask-send"
          onClick={() => void send()}
        >
          {busy ? <Loader2 className="size-3.5 animate-spin" aria-hidden /> : <CornerDownLeft className="size-3.5" aria-hidden />}
          Ask
        </button>
      </div>
    </section>
  );
}
