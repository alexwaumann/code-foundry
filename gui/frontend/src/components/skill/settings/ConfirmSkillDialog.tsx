import { PowerOff, Trash2 } from "lucide-react";
import type { InstalledSkillView } from "@/api/skill";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { runConfirmedSkill } from "@/stores/skillConfirm";
import { confirmCopy, type ConfirmAction } from "./model";

/**
 * Asks before Disable, Uninstall or Remove with the restart warning (the brief's words),
 * then runs the command without the daemon asking again (stores/skillConfirm.ts).
 */
export function ConfirmSkillDialog({ action, row, onClose }: { action: ConfirmAction; row: InstalledSkillView; onClose: () => void }) {
  const copy = confirmCopy(action, row);
  const Icon = action === "disable" ? PowerOff : Trash2;
  const destructive = action !== "disable";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md p-5" data-testid="skill-confirm" data-action={action}>
        <div className="flex gap-3">
          <Icon className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1 space-y-3">
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription className="break-words">{copy.body}</DialogDescription>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="skill-confirm-cancel">
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            autoFocus
            className={cn(
              "bg-transparent dark:bg-transparent",
              destructive && "border-destructive/40 text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/40",
            )}
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
