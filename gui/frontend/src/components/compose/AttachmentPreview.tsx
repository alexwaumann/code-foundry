import { X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { formatAttachmentSize } from "@/lib/prompt";
import { closePreview, useComposeStore } from "@/stores/compose";

/**
 * The image lightbox for a draft attachment (opened from its thumbnail or an inline chip):
 * the image at natural size, capped to the window, under a line with its name and size.
 * Escape, the backdrop and × close it; focus goes back to where it was opened from.
 */
export function AttachmentPreview({ repoId }: { repoId: string }) {
  const preview = useComposeStore((s) => (s.preview?.repoId === repoId ? s.preview : null));
  const att = useComposeStore((s) => (preview ? s.drafts[repoId]?.attachments.find((a) => a.id === preview.id) : undefined));
  return (
    <Dialog
      open={preview?.open === true && att !== undefined}
      onOpenChange={(open) => {
        if (!open) closePreview();
      }}
    >
      <DialogContent
        data-testid="attachment-preview"
        data-attachment-id={att?.id}
        overlayClassName="bg-black/80"
        className="top-1/2 flex w-auto max-w-[90vw] min-w-72 -translate-y-1/2 flex-col overflow-hidden bg-popover/95 p-0"
        onCloseAutoFocus={(e) => {
          const el = preview?.returnFocus;
          if (!el?.isConnected) return;
          e.preventDefault();
          el.focus();
        }}
      >
        <div className="flex min-w-0 items-center gap-3 border-b py-2 pr-2 pl-4">
          <DialogTitle className="min-w-0 truncate" data-testid="attachment-preview-name">
            {att?.file.name}
          </DialogTitle>
          <DialogDescription className="shrink-0 text-xs" data-testid="attachment-preview-size">
            {att ? formatAttachmentSize(att.file.size) : ""}
          </DialogDescription>
          <button
            type="button"
            aria-label="Close preview"
            title="Close"
            data-testid="attachment-preview-close"
            className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            onClick={closePreview}
          >
            <X className="size-4" />
          </button>
        </div>
        {att && <img src={att.url} alt={att.file.name} draggable={false} className="mx-auto block h-auto max-h-[85vh] w-auto max-w-[90vw] object-contain" />}
      </DialogContent>
    </Dialog>
  );
}
