/**
 * Reading an image and making its thumbnail. The full file and its full decode exist only
 * while this runs, one per ThumbStore slot; what a tile keeps is at most THUMB_EDGE px on a
 * side, so a grid of large images does not hold a full-size decode per tile.
 */
import { readFile, type FileReadView } from "@/api/files";
import type { GalleryImage } from "@/surfaces/galleryTarget";
import { ImageFailure } from "./thumbStore";

/** The longest side of a thumbnail in px: a wide tile (about 320 px) at 2x. */
export const THUMB_EDGE = 640;

/** A file's tile says this rather than showing it; null when it is an image to show. */
export function imageFailure(file: FileReadView): string | null {
  if (file.notFound) return "Not found";
  if (file.isDir) return "A folder";
  if (file.image === null) return "Not an image";
  // Only the head of it came back, which would decode as a broken picture.
  return file.truncated ? "Too large" : null;
}

/** The size to draw a width by height image at, its longest side `edge`; null for one that is small enough already. */
export function thumbSize(width: number, height: number, edge: number): { width: number; height: number } | null {
  const scale = edge / Math.max(width, height);
  if (!(scale < 1)) return null;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/** What a thumbnail is encoded as: a JPEG stays one, and anything else may have transparency. */
export function thumbMime(mime: string): string {
  return mime === "image/jpeg" ? mime : "image/png";
}

async function encode(canvas: HTMLCanvasElement, mime: string): Promise<Blob | null> {
  return new Promise((resolve) => {
    canvas.toBlob(resolve, mime, 0.85);
  });
}

/**
 * An object URL for `bytes` at thumbnail size, or for the bytes themselves when they are small
 * in pixels already or an SVG, which has no pixels to hold and no size to trust. What will not
 * decode is an ImageFailure.
 */
async function shrink(bytes: Uint8Array, mime: string): Promise<string> {
  // A copy: a Blob wants an ArrayBuffer-backed view, and the response's bytes may sit in a larger buffer.
  const source = URL.createObjectURL(new Blob([bytes.slice()], { type: mime }));
  const img = new Image();
  img.src = source;
  try {
    await img.decode();
  } catch {
    URL.revokeObjectURL(source);
    throw new ImageFailure("Cannot decode");
  }
  const size = mime === "image/svg+xml" ? null : thumbSize(img.naturalWidth, img.naturalHeight, THUMB_EDGE);
  if (!size) return source;
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  ctx?.drawImage(img, 0, 0, size.width, size.height);
  const blob = ctx ? await encode(canvas, thumbMime(mime)) : null;
  // The browser can let go of the decode now; a canvas it could not encode keeps the source.
  canvas.width = 0;
  if (!blob) return source;
  img.src = "";
  URL.revokeObjectURL(source);
  return URL.createObjectURL(blob);
}

/** ThumbStore's load: reads the image as the File tab does (the same read grants) and shrinks it. */
export async function loadThumb(base: string, image: GalleryImage, signal: AbortSignal): Promise<string> {
  const file = await readFile(base, image.path, undefined, signal);
  const failure = imageFailure(file);
  if (failure !== null || file.image === null) throw new ImageFailure(failure ?? "Not an image");
  return shrink(file.image, file.mime);
}
