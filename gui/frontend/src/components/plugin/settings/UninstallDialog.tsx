import { useState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { uninstallPlugin } from "@/stores/pluginRegistry";
import { usePlugin } from "@/stores/plugins";

/**
 * Asks before uninstalling a plugin, with the choice to delete what it keeps too (plugin
 * uninstall --purge: its data folder, its secrets in the Keychain, its logs and the
 * consent given). The command is then run without asking again.
 */
export function UninstallDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const p = usePlugin(name);
  const [purge, setPurge] = useState(false);
  const displayName = p?.displayName ?? name;
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-w-md p-5" data-testid="uninstall-dialog">
        <div className="flex gap-3">
          <Trash2 className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
          <div className="min-w-0 flex-1 space-y-3">
            <DialogTitle>Uninstall {displayName}?</DialogTitle>
            <DialogDescription className="break-words">
              {p?.dev
                ? "It stops and its link goes from ~/.code-foundry/plugins; your folder stays."
                : "It stops and its package goes from ~/.code-foundry/plugins."}{" "}
              {purge ? "" : "Its data, secrets and the consent you gave stay for a reinstall."}
            </DialogDescription>
            <Label className="items-start gap-2 text-body-sm font-normal">
              <Checkbox
                checked={purge}
                onCheckedChange={(v) => {
                  setPurge(v === true);
                }}
                className="mt-px"
                data-testid="uninstall-purge"
              />
              <span>Also delete its data, its secrets in the Keychain, its logs and the consent given</span>
            </Label>
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={onClose} data-testid="uninstall-cancel">
            Cancel
          </Button>
          <Button
            variant="outline"
            size="sm"
            autoFocus
            className="border-destructive/40 bg-transparent text-destructive hover:bg-destructive/10 hover:text-destructive dark:border-destructive/40 dark:bg-transparent"
            onClick={() => {
              onClose();
              void uninstallPlugin(name, purge);
            }}
            data-testid="uninstall-confirm"
          >
            Uninstall
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
