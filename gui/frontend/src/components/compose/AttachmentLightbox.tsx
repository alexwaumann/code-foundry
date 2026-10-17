import { X } from "lucide-react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Tip } from "@/components/ui/tooltip";
import { pageCount } from "@/lib/compose";
import { cn } from "@/lib/utils";
import { PdfPages } from "./PdfPages";

/**
 * The lightbox for an attachment, a draft's (AttachmentPreview) or a sent message's (the
 * thread's user bubble): an image at natural size, capped to the window; a PDF's pages in
 * a scrolling column at the dialog's width (the same caps), drawn as they come into view.
 * Over either, a line with its name and size (and a PDF's page count). Escape, the
 * backdrop and × close it. `testId` names the dialog; its name, size and close button are
 * `<testId>-name`, `-size` and `-close`.
 */
export function AttachmentLightbox({
  open,
  onClose,
  testId,
  kind,
  name,
  size,
  pages,
  url,
  file,
  attachmentId,
  onCloseAutoFocus,
}: {
  open: boolean;
  onClose: () => void;
  testId: string;
  kind: "image" | "pdf" | undefined;
  name: string;
  /** The size as shown ("1 KB"); "" when unknown. */
  size: string;
  pages: number | null;
  /** The image's URL (an image's preview). */
  url: string | null;
  /** The PDF itself (a PDF's preview). */
  file: Blob | null;
  attachmentId?: string;
  onCloseAutoFocus?: (e: Event) => void;
}) {
  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent
        data-testid={testId}
        data-attachment-id={attachmentId}
        overlayClassName="bg-black/80"
        data-kind={kind}
        className={cn(
          "top-1/2 flex min-w-72 -translate-y-1/2 flex-col overflow-hidden bg-popover/95 p-0",
          kind === "pdf" ? "w-[calc(90vw/var(--cf-zoom))] max-w-4xl" : "w-auto max-w-[calc(90vw/var(--cf-zoom))]",
        )}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <div className="flex min-w-0 items-center gap-3 border-b py-2 pr-2 pl-4">
          <DialogTitle className="min-w-0 truncate" data-testid={`${testId}-name`}>
            {name}
          </DialogTitle>
          <DialogDescription className="shrink-0" data-testid={`${testId}-size`}>
            {size}
            {pages != null && ` · ${pageCount(pages)}`}
          </DialogDescription>
          <Tip label="Close">
            <button
              type="button"
              aria-label="Close preview"
              data-testid={`${testId}-close`}
              className="ml-auto flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
              onClick={onClose}
            >
              <X className="size-4" />
            </button>
          </Tip>
        </div>
        {kind === "pdf" && file && <PdfPages file={file} />}
        {kind === "image" && url && <img src={url} alt={name} draggable={false} className="mx-auto block h-auto max-h-[calc(85vh/var(--cf-zoom))] w-auto max-w-[calc(90vw/var(--cf-zoom))] object-contain" />}
      </DialogContent>
    </Dialog>
  );
}
