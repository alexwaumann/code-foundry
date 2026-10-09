import { CornerDownLeft, Loader2, MessageCircleQuestion } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { startingKey, startPrSession, usePrSessionsStore } from "@/stores/prSessions";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { composerKeyAction } from "./keys";

/**
 * Menu → Ask a question: an inline composer under the PR header. Enter sends the question
 * through pr.ask (startPrSession), Shift+Enter is a newline, Escape cancels. While the
 * command runs the field is read-only; on success the daemon focuses the new session and
 * the composer closes. A failure is toasted and the text stays.
 */
export function PrAskComposer({ prRef, onClose }: { prRef: PrRef; onClose: () => void }) {
  const [text, setText] = useState("");
  const busy = usePrSessionsStore((s) => s.starting[startingKey(prRef, "ask")] ?? false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // After the menu closes (it does not take focus back to its button for this item).
  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.focus());
    return () => {
      cancelAnimationFrame(id);
    };
  }, []);

  /** Closes, handing focus to the panel so its keys keep working. */
  const close = () => {
    const panel = ref.current?.closest<HTMLElement>('[data-region="panel"]');
    onClose();
    panel?.focus();
  };

  const send = async () => {
    if (busy || !text.trim()) return;
    if ((await startPrSession("ask", prRef, text)) !== null) onClose();
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
    if (action === "cancel") close();
    else void send();
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
        readOnly={busy}
        placeholder="Ask about this pull request…"
        className="w-full resize-none rounded-md border border-input bg-transparent px-2.5 py-2 text-[13px] leading-snug outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-ring read-only:opacity-70"
        data-testid="pr-ask-input"
        onChange={(e) => {
          setText(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      <div className="flex min-w-0 items-center gap-2">
        <span className="min-w-0 truncate text-xs text-muted-foreground" data-testid="pr-ask-hint">
          {busy ? "Starting a session…" : "Enter to send · Shift+Enter for a new line"}
        </span>
        <button
          type="button"
          className="ml-auto shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          data-testid="pr-ask-cancel"
          onClick={close}
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !text.trim()}
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
