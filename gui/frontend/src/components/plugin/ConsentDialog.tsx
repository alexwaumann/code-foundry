import { ShieldCheck } from "lucide-react";
import { consentLines } from "@/api/plugin";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { answerConsent, useConsentStore } from "@/stores/pluginConsent";
import { usePluginsStore } from "@/stores/plugins";

/** "Enable Hello 0.1.0?" from the consent text's lead, and the rest of the lead ("It runs bin/hello as you and may:"). */
function splitLead(lead: string): { title: string; rest: string } {
  const q = lead.indexOf("?");
  return q < 0 ? { title: "Enable this plugin?", rest: lead } : { title: lead.slice(0, q + 1), rest: lead.slice(q + 1).trim() };
}

/**
 * Asks before a plugin runs (plugin.enable, plugin.dev): what it runs and the permissions
 * it asks for, in the daemon's words. Shown again when an update asks for more than the
 * user allowed. Enable has focus, so Enter enables and Escape cancels.
 */
export function ConsentDialog() {
  const pending = useConsentStore((s) => s.pending);
  const regrant = usePluginsStore((s) => (pending?.plugin ? s.byName[pending.plugin]?.granted != null : false));
  const { lead, items } = consentLines(pending?.text ?? "");
  const { title, rest } = splitLead(lead);
  return (
    <Dialog
      open={pending !== null}
      onOpenChange={(open) => {
        if (!open) answerConsent(false);
      }}
    >
      <DialogContent className="max-w-md p-5" data-testid="consent-dialog">
        <div className="flex gap-3">
          <ShieldCheck className="mt-0.5 size-5 shrink-0 text-cf-text-muted" aria-hidden />
          <div className="min-w-0 flex-1 space-y-2">
            <DialogTitle data-testid="consent-title">{title}</DialogTitle>
            <DialogDescription className="break-words">{rest || "It asks for no permissions."}</DialogDescription>
            {regrant && (
              <p className="text-caption text-cf-warning-text" data-testid="consent-grew">
                It now asks for more than you allowed before.
              </p>
            )}
            {items.length > 0 && (
              <ul className="flex flex-col gap-1 rounded-lg border border-cf-border px-3 py-2" data-testid="consent-permissions">
                {items.map((p) => (
                  <li key={p} className="flex gap-2 text-body-sm break-words">
                    <span className="text-cf-text-muted" aria-hidden>
                      •
                    </span>
                    <span className="min-w-0">{p}</span>
                  </li>
                ))}
              </ul>
            )}
            {pending?.path && <p className="font-mono text-caption-sm break-all">{pending.path}</p>}
            {pending?.caller && <p className="text-caption-sm">Asked by {pending.caller}</p>}
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              answerConsent(false);
            }}
            data-testid="consent-cancel"
          >
            Cancel
          </Button>
          <Button
            size="sm"
            autoFocus
            onClick={() => {
              answerConsent(true);
            }}
            data-testid="consent-enable"
          >
            Enable
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
