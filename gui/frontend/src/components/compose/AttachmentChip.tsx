import { useContext, useEffect, useState } from "react";
import { NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { ImageIcon } from "lucide-react";
import { formatAttachmentSize, middleTruncate } from "@/lib/prompt";
import { cn } from "@/lib/utils";
import { openPreview, useComposeStore } from "@/stores/compose";
import { ChipRepoContext } from "./chipContext";

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
 * An inline image chip in the prompt: mini thumbnail, (middle-truncated) name and size.
 * A click opens the image preview. A chip whose attachment is gone (pasted from
 * elsewhere, or the image was removed while the text was being undone) still renders,
 * with a dashed border, and a click on it only selects it.
 */
export function AttachmentChipView({ node, selected, editor }: NodeViewProps) {
  const repoId = useContext(ChipRepoContext);
  const id = String(node.attrs.id ?? "");
  const label = String(node.attrs.name ?? "");
  const att = useComposeStore((s) => s.drafts[repoId]?.attachments.find((a) => a.id === id));
  const accent = useAccent(att?.url);
  const name = att?.file.name ?? label;
  const size = att ? formatAttachmentSize(att.file.size) : "";
  return (
    <NodeViewWrapper
      as="span"
      data-testid="prompt-chip"
      data-attachment-id={id}
      data-missing={att ? undefined : "true"}
      role="img"
      aria-label={size ? `Image attachment, ${name}, ${size}` : `Image attachment, ${name} (removed)`}
      title={att ? "Open preview" : `${name} (removed)`}
      aria-keyshortcuts={att ? "Space" : undefined}
      // A click selects the node (ProseMirror, on mousedown) and opens the preview; focus
      // returns to the prompt with the chip still selected, where Space opens it again.
      onClick={
        att
          ? () => {
              openPreview(repoId, id, editor.view.dom);
            }
          : undefined
      }
      style={{ "--chip-accent": accent }}
      className={cn(
        "relative mx-px inline-flex h-[1.41em] max-w-72 items-center gap-[0.33em] rounded-[0.5em] border px-[0.5em] align-middle text-[0.86em] leading-none font-medium select-none",
        "border-[color-mix(in_oklab,var(--chip-accent)_34%,var(--color-border))] bg-[color-mix(in_oklab,var(--chip-accent)_11%,transparent)] text-[color-mix(in_oklab,var(--chip-accent)_22%,var(--color-foreground))]",
        "hover:border-[color-mix(in_oklab,var(--chip-accent)_48%,var(--color-border))] hover:bg-[color-mix(in_oklab,var(--chip-accent)_17%,transparent)]",
        att ? "cursor-pointer" : "border-dashed",
        selected && "after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:bg-[Highlight]/30",
      )}
    >
      {att ? <img src={att.url} alt="" draggable={false} className="size-[1.17em] shrink-0 rounded-sm object-cover" /> : <ImageIcon aria-hidden className="size-[1.17em] shrink-0" />}
      <span className="truncate">{middleTruncate(name)}</span>
      {size && <span className="shrink-0 text-[0.8em] font-normal opacity-70">{size}</span>}
    </NodeViewWrapper>
  );
}
