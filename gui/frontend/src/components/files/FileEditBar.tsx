import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { formatChord } from "@/keys/chord";
import { cn } from "@/lib/utils";
import { useCommandsStore } from "@/stores/commands";
import type { EditConflict } from "@/stores/fileEdit";

/** Row two's state of an editing tab: "Unsaved" with an amber dot, or plain "Editing". */
export function EditStatus({ dirty }: { dirty: boolean }) {
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-caption-sm" data-testid="file-edit-status">
      {dirty && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-cf-warning" />}
      {dirty ? "Unsaved" : "Editing"}
    </span>
  );
}

/** Row two's Discard and Save, both off while there is nothing to discard or save. The chord shown is file.save's, wherever the user put it. */
export function EditButtons({ dirty, saving, onDiscard, onSave }: { dirty: boolean; saving: boolean; onDiscard: () => void; onSave: () => void }) {
  const chord = useCommandsStore((s) => s.commands.find((c) => c.name === "file.save")?.keybindings[0]);
  return (
    <span className="flex shrink-0 items-center gap-1">
      <Button variant="ghost" size="xs" disabled={!dirty || saving} onClick={onDiscard} data-testid="file-discard">
        Discard
      </Button>
      <Button size="xs" disabled={!dirty || saving} onClick={onSave} data-testid="file-save">
        Save
        {chord && <span className="font-normal opacity-70">{formatChord(chord)}</span>}
      </Button>
    </span>
  );
}

const BAND = "flex shrink-0 items-center gap-2 border-b border-cf-divider px-3 py-1 text-caption-sm";

/**
 * Under the header, when the file moved on from the draft: the draft stays, and the user
 * says which one wins. Reload takes what is on disk; Overwrite saves with force, which makes
 * a deleted file again.
 */
export function ConflictBand({ conflict, onReload, onOverwrite }: { conflict: EditConflict; onReload: () => void; onOverwrite: () => void }) {
  return (
    <div className={cn(BAND, "bg-cf-warning-surface text-cf-warning-text")} role="status" data-testid="file-conflict" data-conflict={conflict}>
      <TriangleAlert className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{conflict === "deleted" ? "Deleted on disk" : "Changed on disk"}</span>
      {conflict === "changed" && (
        <Button variant="ghost" size="xs" onClick={onReload} data-testid="file-reload">
          Reload
        </Button>
      )}
      <Button variant="outline" size="xs" onClick={onOverwrite} data-testid="file-overwrite">
        Overwrite
      </Button>
    </div>
  );
}

/** Under the header, when a save failed: the daemon's message, whole. The draft is still there. */
export function SaveFailedBand({ message }: { message: string }) {
  return (
    <div className={cn(BAND, "bg-cf-error-surface text-cf-error-text")} role="alert" data-testid="file-save-failed">
      <TriangleAlert className="size-3 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 break-words">Could not save: {message}</span>
    </div>
  );
}
