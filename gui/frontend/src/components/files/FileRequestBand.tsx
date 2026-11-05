import { MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { FileAsk } from "@/surfaces/fileTarget";
import { useThreadsStore } from "@/stores/threads";
import { SaveChord } from "./FileEditBar";

/**
 * Directly under the header while a thread's request to edit this file stands
 * (stores/fileRequest.ts): who asked, by the thread's current name, and what they said. The
 * note is model text, so it is shown as text: no markdown, no links, no HTML.
 */
export function FileRequestBand({ ask, canTell, onTell, onDismiss }: { ask: FileAsk; canTell: boolean; onTell: () => void; onDismiss: () => void }) {
  const name = useThreadsStore((s) => s.byId[ask.thread]?.name);
  return (
    <div className="flex shrink-0 gap-2 border-b border-cf-divider bg-cf-surface-raised px-3 py-2" data-testid="file-request">
      <MessageSquareText className="mt-px size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-caption-sm font-medium break-words">{name || "A thread"} asked you to edit this file</p>
        {ask.note && (
          <p className="text-caption break-words whitespace-pre-wrap" data-testid="file-request-note">
            {ask.note}
          </p>
        )}
        <div className="mt-1 flex justify-end gap-1">
          <Button variant="ghost" size="xs" onClick={onDismiss} data-testid="file-request-dismiss">
            Dismiss
          </Button>
          <Button size="xs" disabled={!canTell} onClick={onTell} data-testid="file-request-tell">
            Save and tell thread
            <SaveChord />
          </Button>
        </div>
      </div>
    </div>
  );
}
