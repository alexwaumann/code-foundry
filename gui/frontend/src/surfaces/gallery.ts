import { createElement } from "react";
import { Images } from "lucide-react";
import { GalleryTab } from "@/components/gallery/GalleryTab";
import { GALLERY_KIND } from "./galleryTarget";
import type { SurfaceSpec } from "./types";

/**
 * Gallery: a set of images a thread shows (components/gallery/GalleryTab.tsx), as a grid that
 * opens one image over a filmstrip. Never listed and no hotkey: view.open.gallery is the only
 * way in (the daemon opens its tab), one tab per title: params { title, images, project,
 * base } (surfaces/galleryTarget.ts). Opening one from an image in a thread would be another
 * caller of galleryTab.
 */
export const gallerySurface: SurfaceSpec = {
  kind: GALLERY_KIND,
  title: "Gallery",
  icon: Images,
  available: () => "hidden",
  render: (tab) => createElement(GalleryTab, { base: tab.params.base ?? "", images: tab.params.images ?? "" }),
  openDefault: () => null,
};
