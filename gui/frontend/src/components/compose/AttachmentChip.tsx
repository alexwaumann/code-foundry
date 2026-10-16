import { useContext, useEffect, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { FileText, ImageIcon } from "lucide-react";
import { Tip } from "@/components/ui/tooltip";
import { pageCount } from "@/lib/compose";
import { formatAttachmentSize, kindFromName, middleTruncate } from "@/lib/prompt";
import { cn } from "@/lib/utils";
import { openPreview, useComposeStore } from "@/stores/compose";
import { TagDraftContext } from "./tagContext";
import { TAG_ACCENT, tagClass } from "./tagStyle";

const DEFAULT_ACCENT = "oklch(0.62 0.16 16)";
const accents = new Map<string, string | null>();

/** The thumbnail's average colour (alpha-weighted, sampled at 16×16), or null. */
function averageColor(img: HTMLImageElement): string | null {
  try {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 16;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(img, 0, 0, 16, 16);
    const { data } = ctx.getImageData(0, 0, 16, 16);
    let r = 0;
    let g = 0;
    let b = 0;
    let w = 0;
    for (let i = 0; i < data.length; i += 4) {
      const a = (data[i + 3] ?? 0) / 255;
      r += (data[i] ?? 0) * a;
      g += (data[i + 1] ?? 0) * a;
      b += (data[i + 2] ?? 0) * a;
      w += a;
    }
    if (w < 1) return null;
    return `rgb(${String(Math.round(r / w))} ${String(Math.round(g / w))} ${String(Math.round(b / w))})`;
  } catch {
    return null;
  }
}

/** Accent colour for a chip: sampled once per thumbnail URL, the default meanwhile. */
function useAccent(url: string | undefined): string {
  const [sampled, setSampled] = useState<{ url: string; color: string | null } | null>(null);
  useEffect(() => {
    if (!url || accents.has(url)) return;
    let live = true;
    const img = new Image();
    img.onload = () => {
      const color = averageColor(img);
      accents.set(url, color);
      if (live) setSampled({ url, color });
    };
    img.src = url;
    return () => {
      live = false;
    };
  }, [url]);
  if (!url) return DEFAULT_ACCENT;
  return (accents.get(url) ?? (sampled?.url === url ? sampled.color : null)) ?? DEFAULT_ACCENT;
}

/**
 * An inline attachment chip in the prompt (a TagView of kind image): for an image, its
 * mini thumbnail, (middle-truncated) name and size, tinted with the image's colour; for a
 * PDF, its first page (an icon until it renders), name and page count (the size while
 * counting, and in the tooltip), in the file tags' accent. A click opens the preview. A
 * chip whose attachment is gone (pasted from elsewhere, or removed while the text was
 * being undone) still renders, with a dashed border, and a click on it only selects it.
 */
export function AttachmentChip({ id, label, selected, editor }: { id: string; label: string; selected: boolean; editor: NodeViewProps["editor"] }) {
  const draftKey = useContext(TagDraftContext);
  const att = useComposeStore((s) => s.drafts[draftKey]?.attachments.find((a) => a.id === id));
  const pdf = (att?.kind ?? kindFromName(label)) === "pdf";
  const accent = useAccent(pdf ? undefined : att?.url);
  const name = att?.file.name ?? label;
  const size = att ? formatAttachmentSize(att.file.size) : "";
  const detail = pdf && att?.pages != null ? pageCount(att.pages) : size;
  const what = pdf ? "PDF" : "Image";
  // A removed attachment says so in its tooltip; a PDF shows its size there (the chip shows pages).
  const tip = !att ? `${name} (removed)` : pdf && detail !== size ? size : null;
  return (
    <Tip label={tip}>
      <NodeViewWrapper
        as="span"
        data-testid="prompt-chip"
        data-tag-kind="image"
        data-attachment-kind={pdf ? "pdf" : "image"}
        data-attachment-id={id}
        data-missing={att ? undefined : "true"}
        role="img"
        aria-label={att ? `${what} attachment, ${name}, ${detail}` : `${what} attachment, ${name} (removed)`}
        aria-keyshortcuts={att ? "Space" : undefined}
        // A click selects the node (ProseMirror, on mousedown) and opens the preview; focus
        // returns to the prompt with the chip still selected, where Space opens it again.
        onClick={
          att
            ? () => {
                openPreview(draftKey, id, editor.view.dom);
              }
            : undefined
        }
        style={pdf ? undefined : { "--chip-accent": accent }}
        className={tagClass(selected, cn(pdf && TAG_ACCENT.file, att ? "cursor-pointer" : "border-dashed"))}
      >
        <ChipIcon pdf={pdf} src={att ? (pdf ? att.thumb : att.url) : null} />
        <span className="truncate">{middleTruncate(name)}</span>
        {detail && <span className="shrink-0 text-caption-sm leading-none text-inherit opacity-70">{detail}</span>}
      </NodeViewWrapper>
    </Tip>
  );
}

function ChipIcon({ pdf, src }: { pdf: boolean; src: string | null }) {
  if (src) return <img src={src} alt="" draggable={false} className={cn("size-[1.17em] shrink-0 rounded-sm object-cover", pdf && "object-top")} />;
  const Icon = pdf ? FileText : ImageIcon;
  return <Icon aria-hidden className="size-[1.17em] shrink-0" />;
}
