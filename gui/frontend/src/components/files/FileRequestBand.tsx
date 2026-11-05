import { MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { plainLine } from "@/lib/plainText";
import { askerLabel } from "@/stores/fileRequest";
import { useThreadsStore } from "@/stores/threads";
import type { FileAsk } from "@/surfaces/fileTarget";
import { SaveChord } from "./FileEditBar";

/**
 * Directly under the header while a thread's request to edit this file stands
 * (stores/fileRequest.ts). The thread's name and note are model text, which anyone's input can
 * have written, so neither may pass for the app or take the band over: the name is quoted and
 * cut, the note is a quotation, both are cleaned to plain text (no markdown, links or HTML). A
 * link's target is anyone's text too, so the facts share the note's box, which scrolls, and no
 * text here can push the buttons away. The facts come first: a note cannot push them out of it.
 */
export function FileRequestBand({ ask, canTell, facts, onTell, onDismiss }: { ask: FileAsk; canTell: boolean; facts: readonly string[]; onTell: () => void; onDismiss: () => void }) {
  const name = useThreadsStore((s) => s.byId[ask.thread]?.name);
  const note = plainLine(ask.note);
  return (
    <div className="flex shrink-0 gap-2 overflow-hidden border-b border-cf-divider bg-cf-surface-raised px-3 py-2" data-testid="file-request">
      <MessageSquareText className="mt-px size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="overflow-hidden text-caption-sm font-medium break-words">{askerLabel(name)} asked you to edit this file</p>
        {(note || facts.length > 0) && (
          <div className="flex max-h-24 flex-col gap-1 overflow-y-auto" data-testid="file-request-details">
            {facts.map((fact) => (
              <p key={fact} className="text-caption break-words text-cf-warning-text" data-testid="file-request-fact">
                {fact}
              </p>
            ))}
            {note && (
              <blockquote className="border-l-2 border-cf-divider pl-2 text-caption italic break-words" data-testid="file-request-note">
                {note}
              </blockquote>
            )}
          </div>
        )}
        <div className="flex justify-end gap-1">
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
