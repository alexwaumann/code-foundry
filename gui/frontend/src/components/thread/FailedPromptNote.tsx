import { CircleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useDraft } from "@/stores/compose";
import { useFailedPrompt } from "@/stores/failedNotice";
import { getThreadItems } from "@/stores/thread";
import { editThreadMessage, resendThreadMessage, threadDraftKey } from "@/stores/threadActions";

/** The failed user message as sent, read when a button is pressed (null when it is gone). */
function sentMessage(threadId: string, itemId: string) {
  const it = getThreadItems(threadId).find((x) => x.id === itemId);
  return it?.kind === "user" ? { text: it.text, composerText: it.composerText, attachments: it.attachments } : null;
}

/**
 * The composer's one-line notice at the top of the card when the thread's last prompt got
 * no reply because its turn failed (docs/notes/composer-failed-notice.md; the rule is
 * lib/failedPrompt): "<reason>, so your message was not sent." with Edit (the prompt back
 * in the editor, tags and attachments included, after a blank line when there is a draft;
 * focused) and Send again (the same message through thread.send, so a stopped thread
 * starts). No close button: any message sent, or Claude's reply, clears it. Hidden while
 * a send from this composer is in flight.
 */
export function FailedPromptNote({ threadId, pending, focusEditor }: { threadId: string; pending: number; focusEditor: () => void }) {
  const failed = useFailedPrompt(threadId, pending);
  const phase = useDraft(threadDraftKey(threadId), "phase");
  if (!failed || phase !== "idle") return null;
  const edit = async () => {
    const m = sentMessage(threadId, failed.itemId);
    if (!m || !(await editThreadMessage(threadId, m))) return;
    // After the editor has taken the new text (it rebuilds on the next render).
    requestAnimationFrame(focusEditor);
  };
  const resend = () => {
    const m = sentMessage(threadId, failed.itemId);
    if (m) void resendThreadMessage(threadId, m);
  };
  return (
    <div className="col-span-2 flex min-w-0 items-center gap-2 border-b border-cf-border py-2 pr-2 pl-4 text-body-sm" role="status" data-testid="thread-failed-note">
      <CircleAlert className="size-3.5 shrink-0 text-cf-error-text" aria-hidden />
      <span className="min-w-0 flex-1 truncate" data-testid="thread-failed-reason">
        {failed.line}
      </span>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          className="font-normal text-cf-text-muted hover:text-cf-text"
          data-testid="thread-failed-edit"
          onClick={() => {
            void edit();
          }}
        >
          Edit
        </Button>
        <Button type="button" variant="secondary" size="xs" className="bg-cf-control-hover font-normal text-cf-text hover:bg-cf-control-active" data-testid="thread-failed-resend" onClick={resend}>
          Send again
        </Button>
      </div>
    </div>
  );
}
