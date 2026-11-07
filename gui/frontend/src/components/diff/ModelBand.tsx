import { MessageSquareText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { plainLine } from "@/lib/plainText";
import { askerLabel } from "@/stores/fileRequest";
import { useThreadsStore } from "@/stores/threads";
import { narrowedTo } from "./files";

/**
 * Which thread framed this Diff tab (view.panel.diff --title, --note, --hide, or a narrowed
 * list), and the user's way back. A title and a note are model text, which anyone's input can
 * have written, so as in FileRequestBand neither may pass for the app: the thread is named,
 * the title sits in that sentence, the note is a quotation, and all are plain text. A list a
 * thread narrowed says so. No thread can lock a user out of the tab: anything taken away comes
 * back from here, and a note can be dismissed.
 */
export function ModelBand({
  thread,
  heading,
  note,
  paths,
  hidden,
  onReveal,
  onDismiss,
}: {
  thread: string;
  heading: string;
  note: string;
  paths: readonly string[];
  hidden: boolean;
  onReveal: () => void;
  onDismiss: () => void;
}) {
  const name = useThreadsStore((s) => s.byId[thread]?.name);
  const title = plainLine(heading);
  const said = plainLine(note);
  return (
    <div className="flex shrink-0 gap-2 overflow-hidden border-b border-cf-divider bg-cf-surface-raised px-3 py-2" data-testid="diff-model-band">
      <MessageSquareText className="mt-px size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <p className="overflow-hidden text-caption-sm font-medium break-words" data-testid="diff-model-title">
          {askerLabel(name)} {title ? `opened this as “${title}”` : "opened this view"}
        </p>
        {said && (
          <blockquote className="max-h-24 overflow-y-auto border-l-2 border-cf-divider pl-2 text-caption italic break-words" data-testid="diff-model-note">
            {said}
          </blockquote>
        )}
        {paths.length > 0 && (
          <p className="text-caption break-words" data-testid="diff-narrowed">
            {narrowedTo(paths)}
          </p>
        )}
        {(hidden || paths.length > 0 || said) && (
          <div className="flex justify-end gap-1">
            {said && (
              <Button variant="ghost" size="xs" onClick={onDismiss} data-testid="diff-note-dismiss">
                Dismiss
              </Button>
            )}
            {(hidden || paths.length > 0) && (
              <Button variant="ghost" size="xs" onClick={onReveal} data-testid="diff-reveal">
                {hidden ? "Show controls" : "Show all files"}
              </Button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
