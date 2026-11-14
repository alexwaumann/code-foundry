/**
 * The Gallery surface's tabs (docs/notes/gallery-surface.md). One tab per title: the id comes
 * from the title alone, so opening a title again finds its tab and openTab (shell/host.ts)
 * hands it the new images. The images are the daemon's JSON (view.panel.gallery) kept as it
 * came, since a tab's params are strings. Pure.
 */
import { fileName } from "@/lib/filePath";
import { plainLine } from "@/lib/plainText";
import { tabId, type Tab } from "@/shell/host";

export const GALLERY_KIND = "gallery";

/** One image of a gallery. */
export interface GalleryImage {
  /** Absolute when the daemon could read it; otherwise as the thread gave it. */
  path: string;
  /** Model text, cleaned; "" for none. */
  caption: string;
  /** The file's modification time the daemon saw; 0 for an image that will not show. */
  stamp: number;
}

/** The tab view.panel.gallery's params open: { title, images, project, base }. Null when they name no images. */
export function galleryTab(p: Readonly<Record<string, string>>): Tab | null {
  const title = p.title ?? "";
  const images = p.images ?? "";
  if (!title || parseGalleryImages(images).length === 0) return null;
  return { id: tabId(GALLERY_KIND, { title }), kind: GALLERY_KIND, title, params: { title, images, project: p.project ?? "", base: p.base ?? "" } };
}

/** A tab's images param, as a list; what is not an image is left out, and bad JSON is none. */
export function parseGalleryImages(raw: string): readonly GalleryImage[] {
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  return list.flatMap((v: unknown): GalleryImage[] => {
    if (typeof v !== "object" || v === null) return [];
    const { path, caption, stamp } = v as { path?: unknown; caption?: unknown; stamp?: unknown };
    if (typeof path !== "string" || !path) return [];
    return [{ path, caption: typeof caption === "string" ? plainLine(caption) : "", stamp: typeof stamp === "number" ? stamp : 0 }];
  });
}

/** Which version of which file an image is: an image rewritten at its path is another one. */
export function imageKey(image: GalleryImage): string {
  return `${String(image.stamp)}:${image.path}`;
}

/** The file's name, the end of the path when it has none. */
export function imageName(image: GalleryImage): string {
  return fileName(image.path) || image.path;
}

/** What names an image to the user: its caption, else its file's name. */
export function imageLabel(image: GalleryImage): string {
  return image.caption || imageName(image);
}
