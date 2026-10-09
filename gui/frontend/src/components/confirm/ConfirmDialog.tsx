import { TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { answerConfirm, useConfirmStore } from "@/stores/confirm";

/**
 * Asks before a destructive command runs (Command.requires_confirmation). The confirm
 * button has focus, so Enter confirms and Escape cancels.
 */
export function ConfirmDialog() {
  const pending = useConfirmStore((s) => s.pending);
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) answerConfirm(false);
      }}
    >
      <DialogContent className={cn("max-w-md p-5", pending?.centered && "top-1/2 -translate-y-1/2")} data-testid="confirm-dialog">
        <div className="flex gap-3">
          <TriangleAlert className="mt-0.5 size-5 shrink-0 text-destructive" aria-hidden />
          <div className="min-w-0 space-y-2">
            <DialogTitle>{pending?.title}</DialogTitle>
            <DialogDescription className="break-words">{pending?.message}</DialogDescription>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              answerConfirm(false);
            }}
            data-testid="confirm-cancel"
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            size="sm"
            autoFocus
            onClick={() => {
              answerConfirm(true);
            }}
            data-testid="confirm-ok"
          >
            {pending?.confirmLabel ?? "Confirm"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
