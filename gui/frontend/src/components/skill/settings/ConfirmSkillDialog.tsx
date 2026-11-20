import { Trash2 } from "lucide-react";
import type { InstalledSkillView } from "@/api/skill";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { runConfirmedSkill } from "@/stores/skillConfirm";
import { confirmCopy, type ConfirmAction } from "./model";

/**
 * Asks before Uninstall or Delete with the restart warning (the brief's words), then runs
 * the command without the daemon asking again (stores/skillConfirm.ts). Uninstall has focus
 * (it can be installed again); Delete erases a skill the user wrote, so Cancel has it.
 */
export function ConfirmSkillDialog({ action, row, onClose }: { action: ConfirmAction; row: InstalledSkillView; onClose: () => void }) {
  const copy = confirmCopy(action, row);
  const permanent = action === "remove";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md p-5" data-testid="skill-confirm" data-action={action}>
        <div className="flex gap-3">
          <Trash2 className="mt-0.5 size-5 shrink-0 text-cf-text-muted" aria-hidden />
          <div className="min-w-0 flex-1 space-y-3">
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription className="break-words">{copy.body}</DialogDescription>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" autoFocus={permanent} onClick={onClose} data-testid="skill-confirm-cancel">
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            autoFocus={!permanent}
            className="border-cf-error/40 bg-transparent text-cf-error-text hover:bg-cf-error-surface hover:text-cf-error-text dark:border-cf-error/40 dark:bg-transparent"
            onClick={() => {
              onClose();
              void runConfirmedSkill(action, row);
            }}
            data-testid="skill-confirm-ok"
          >
            {copy.label}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
