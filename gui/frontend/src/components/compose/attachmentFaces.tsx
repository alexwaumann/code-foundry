import { FileText, ImageIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * An attachment's faces, shared by the composers (a draft's tiles and chips) and a
 * thread's user bubbles (what a message sent).
 */

/** A PDF tile's face: the first page on a muted ground (the icon until it renders) over a "PDF" strip. */
export function PdfTile({ thumb }: { thumb: string | null }) {
  return (
    <span className="flex size-full flex-col bg-muted">
      <span className="flex min-h-0 flex-1 items-center justify-center p-1">
        {thumb ? (
          <img src={thumb} alt="" draggable={false} className="max-h-full max-w-full object-contain shadow-sm ring-1 ring-border" />
        ) : (
          <FileText aria-hidden className="size-5 text-muted-foreground" />
        )}
      </span>
      <span aria-hidden className="border-t bg-popover text-center text-caption-sm font-medium text-muted-foreground">
        PDF
      </span>
    </span>
  );
}

/**
 * An attachment chip's contents: the mini thumbnail (an image, or a PDF's first page; an
 * icon until there is one), the middle-truncated name, and a detail (size or pages).
 */
export function ChipFace({ pdf, src, name, detail }: { pdf: boolean; src: string | null; name: string; detail?: string }) {
  const Icon = pdf ? FileText : ImageIcon;
  return (
    <>
      {src ? (
        <img src={src} alt="" draggable={false} className={cn("size-[1.17em] shrink-0 rounded-sm object-cover", pdf && "object-top ring-1 ring-border")} />
      ) : (
        <Icon aria-hidden className="size-[1.17em] shrink-0" />
      )}
      <span className="truncate">{name}</span>
      {detail && <span className="shrink-0 text-caption-sm leading-none text-inherit opacity-70">{detail}</span>}
    </>
  );
}
