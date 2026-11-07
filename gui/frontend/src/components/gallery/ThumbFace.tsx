import { ImageOff } from "lucide-react";
import { imageName, type GalleryImage } from "@/surfaces/galleryTarget";
import type { Thumb } from "./thumbStore";

/**
 * What fills a tile or a filmstrip thumbnail: the picture, nothing while it loads, or the
 * failure. `named` says the failure in words, with the file's name, where there is room.
 */
export function ThumbFace({ thumb, image, alt, named }: { thumb: Thumb; image: GalleryImage; alt: string; named?: boolean }) {
  if (thumb.state === "ready") return <img src={thumb.url} alt={alt} decoding="async" draggable={false} className="size-full object-contain" />;
  if (thumb.state === "loading") return null;
  return (
    <span className="flex size-full min-w-0 flex-col items-center justify-center gap-1 p-2 text-center">
      <ImageOff className="size-4 shrink-0 text-cf-text-muted" aria-hidden />
      {named && (
        <>
          <span className="w-full truncate text-caption text-cf-text">{imageName(image)}</span>
          <span className="w-full truncate text-caption-sm text-cf-error-text">{thumb.reason}</span>
        </>
      )}
    </span>
  );
}
