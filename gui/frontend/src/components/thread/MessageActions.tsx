import { useState } from "react";
import type { DeliveryView } from "@/api/thread";
import type { SentMessage } from "@/lib/failedPrompt";
import { cancelThreadMessage, resendNotSentMessage } from "@/stores/threadActions";
import { useThreadCtx } from "./context";

/**
 * A message's own controls in its caption row (docs/notes/cancel-queued-messages.md), for
 * the user's own message Claude has not read: Cancel while it is queued (it leaves Claude's
 * queue and its text comes back to the composer); Re-send and Cancel once it was not sent
 * (Claude stopped first, or an interrupt held it). Plain words, always shown while they
 * apply (not on hover: they must be easy to find), so no tooltip. They sit at the row's left,
 * before Copy and the caption: the caption keeps its place when they go (Claude read the
 * message), and they are no taller than Copy, so the row keeps its height.
 */
export function MessageActions({ itemId, delivery, sent }: { itemId: string; delivery: Extract<DeliveryView, "queued" | "unsent">; sent: SentMessage }) {
  const { threadId } = useThreadCtx();
  const [busy, setBusy] = useState(false);
  const run = (fn: () => Promise<boolean>) => {
    setBusy(true);
    void fn().finally(() => {
      setBusy(false);
    });
  };
  return (
    <span className="mact" data-testid="thread-message-actions">
      {delivery === "unsent" && (
        <button
          type="button"
          className="text-caption"
          data-testid="thread-message-resend"
          disabled={busy}
          onClick={() => {
            run(() => resendNotSentMessage(threadId, itemId));
          }}
        >
          Re-send
        </button>
      )}
      <button
        type="button"
        className="text-caption"
        data-testid="thread-message-cancel"
        disabled={busy}
        onClick={() => {
          run(() => cancelThreadMessage(threadId, itemId, sent));
        }}
      >
        Cancel
      </button>
    </span>
  );
}
