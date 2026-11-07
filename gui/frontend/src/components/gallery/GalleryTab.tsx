import { useEffect, useMemo, useRef, useState } from "react";
import { ImageOff } from "lucide-react";
import { FileEmptyState } from "@/components/files/states";
import { parseGalleryImages } from "@/surfaces/galleryTarget";
import { GalleryGrid } from "./GalleryGrid";
import { GallerySingle } from "./GallerySingle";
import { followOpen } from "./layout";
import { loadThumb } from "./thumbnail";
import { ThumbStore } from "./thumbStore";

/**
 * A Gallery tab's body (surfaces/gallery.ts): the grid, or one image over a filmstrip. Its
 * thumbnails live here, so they go with the tab's body, as a File tab's read does, and come
 * back from the files when it mounts again. A re-open with the same title lands here as new
 * `images`: the single view stays on its file if the new list has it.
 */
export function GalleryTab({ base, images: raw }: { base: string; images: string }) {
  const images = useMemo(() => parseGalleryImages(raw), [raw]);
  const store = useMemo(() => new ThumbStore((image, signal) => loadThumb(base, image, signal), (url) => { URL.revokeObjectURL(url); }), [base]);
  useEffect(
    () => () => {
      store.clear();
    },
    [store],
  );
  const [open, setOpen] = useState<number | null>(null);
  const [reveal, setReveal] = useState<number | null>(null);
  const offset = useRef(0);
  const [seen, setSeen] = useState(images);
  if (images !== seen) {
    setSeen(images);
    setOpen(followOpen(seen, images, open));
  }
  // An image opened by hand ends the last reveal, or a re-open that drops it to the grid would replay that.
  const openImage = (at: number) => {
    setReveal(null);
    setOpen(at);
  };
  if (images.length === 0) return <FileEmptyState icon={ImageOff} heading="No images" testId="gallery-empty" />;
  if (open !== null) {
    return (
      <GallerySingle
        base={base}
        images={images}
        at={open}
        store={store}
        onMove={setOpen}
        onClose={() => {
          setReveal(open);
          setOpen(null);
        }}
      />
    );
  }
  return (
    <>
      <p className="shrink-0 px-3 pt-2 text-caption" data-testid="gallery-count">
        {images.length === 1 ? "1 image" : `${String(images.length)} images`}
      </p>
      <GalleryGrid images={images} store={store} onOpen={openImage} offsetRef={offset} reveal={reveal} />
    </>
  );
}
