import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatChord } from "@/keys/chord";
import { cn } from "@/lib/utils";
import { useCommandsStore } from "@/stores/commands";
import type { EditConflict } from "@/stores/fileEdit";

/** Row two's state of an editing tab: "Unsaved" with an amber dot, or plain "Editing"; "New file" while no file is behind the document. */
export function EditStatus({ dirty, creating }: { dirty: boolean; creating: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-caption-sm" data-testid="file-edit-status">
      {dirty && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-cf-warning" />}
      {creating ? "New file" : dirty ? "Unsaved" : "Editing"}
    </span>
  );
}

/** file.save's chord on a button, wherever the user put it. */
export function SaveChord() {
  const chord = useCommandsStore((s) => s.commands.find((c) => c.name === "file.save")?.keybindings[0]);
  return chord ? <span className="font-normal opacity-70">{formatChord(chord)}</span> : null;
}

/**
 * Row two's Discard and Save, both off while there is nothing to discard or save or a write
 * or reload is out. A file that went can be discarded clean too: there is nothing else
 * to do with the tab. Save shows the chord unless a thread's request has it (`chord` off).
 */
export function EditButtons({ dirty, gone, busy, chord, onDiscard, onSave }: { dirty: boolean; gone: boolean; busy: boolean; chord: boolean; onDiscard: () => void; onSave: () => void }) {
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button variant="ghost" size="xs" disabled={!(dirty || gone) || busy} onClick={onDiscard} data-testid="file-discard">
        Discard
      </Button>
      <Button size="xs" disabled={!dirty || busy} onClick={onSave} data-testid="file-save">
        Save
        {chord && <SaveChord />}
      </Button>
    </span>
  );
}

const BAND = "flex shrink-0 items-center gap-2 border-b border-cf-divider px-3 py-1 text-caption-sm";

/**
 * Under the header, when the file moved on from the draft: the draft stays, and the user
 * says which one wins. Reload takes what is on disk; Overwrite saves with force, which makes
 * a deleted file again (row two's Discard gives up on it). Both wait for a write or reload
 * that is out: answering over it would leave the document and the disk apart.
 */
export function ConflictBand({ conflict, busy, onReload, onOverwrite }: { conflict: EditConflict; busy: boolean; onReload: () => void; onOverwrite: () => void }) {
  return (
    <div className={cn(BAND, "bg-cf-warning-surface text-cf-warning-text")} role="status" data-testid="file-conflict" data-conflict={conflict}>
      <TriangleAlert className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{conflict === "deleted" ? "Deleted on disk" : "Changed on disk"}</span>
      {conflict === "changed" && (
        <Button variant="ghost" size="xs" disabled={busy} onClick={onReload} data-testid="file-reload">
          Reload
        </Button>
      )}
      <Button variant="outline" size="xs" disabled={busy} onClick={onOverwrite} data-testid="file-overwrite">
        Overwrite
      </Button>
    </div>
  );
}

/** Under the header, when a save or a reload failed: the message, whole. The draft is still there. */
export function EditFailedBand({ message }: { message: string }) {
  return (
    <div className={cn(BAND, "bg-cf-error-surface text-cf-error-text")} role="alert" data-testid="file-edit-failed">
      <TriangleAlert className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">{message}</span>
    </div>
  );
}
