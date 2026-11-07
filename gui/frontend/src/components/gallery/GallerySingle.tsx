import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowLeft, ImageOff } from "lucide-react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { readFile } from "@/api/files";
import { HeaderAction } from "@/components/files/FileHeader";
import { ImagePreview } from "@/components/files/ImagePreview";
import { FileEmptyState, FileLoading } from "@/components/files/states";
import { useTabRead } from "@/components/files/useTabRead";
import { Tip } from "@/components/ui/tooltip";
import { chordFromEvent } from "@/keys/chord";
import { cn } from "@/lib/utils";
import { imageKey, imageLabel, type GalleryImage } from "@/surfaces/galleryTarget";
import { FILM_GAP, FILM_HEIGHT, FILM_WIDTH, singleKey } from "./layout";
import { imageFailure } from "./thumbnail";
import { ThumbFace } from "./ThumbFace";
import type { ThumbStore } from "./thumbStore";
import { useThumb } from "./useThumb";

/** The header's meta wants a size; the gallery shows none. */
const noSize = () => undefined;

/** One image at full size, through the File tab's preview: the only full image a gallery holds. */
function FullImage({ base, image, store }: { base: string; image: GalleryImage; store: ThumbStore }) {
  const read = useTabRead(imageKey(image), (signal) => readFile(base, image.path, undefined, signal));
  const thumb = useThumb(store, image);
  const [broken, setBroken] = useState(false);
  const failure = read.data ? imageFailure(read.data) : null;
  if (read.error !== null || failure !== null || broken) {
    const heading = failure ?? (broken ? "Cannot decode" : "Cannot read");
    return <FileEmptyState icon={ImageOff} heading={heading} detail={read.error ?? image.path} testId="gallery-image-failed" />;
  }
  if (read.data?.image) {
    return (
      <ImagePreview
        bytes={read.data.image}
        mime={read.data.mime}
        name={imageLabel(image)}
        onSize={noSize}
        onFail={() => {
          setBroken(true);
        }}
      />
    );
  }
  // The thumbnail stands in while the file reads, so moving through images does not flash.
  if (thumb.state === "ready") {
    return (
      <div className="cf-checker flex min-h-0 flex-1 items-center justify-center p-4" data-testid="gallery-image-loading">
        <img src={thumb.url} alt="" className="size-full object-contain" />
      </div>
    );
  }
  return <FileLoading />;
}

/** One filmstrip thumbnail: the image it opens, and the one showing marked. */
function FilmFrame({ image, index, current, store, onPick }: { image: GalleryImage; index: number; current: boolean; store: ThumbStore; onPick: (index: number) => void }) {
  const thumb = useThumb(store, image);
  const label = imageLabel(image);
  return (
    <Tip label={label}>
      <button
        type="button"
        className={cn(
          "block overflow-hidden rounded-md border bg-cf-surface-sunken outline-none",
          current ? "border-cf-accent ring-1 ring-cf-accent" : "border-cf-divider opacity-70 hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-cf-accent/40",
        )}
        style={{ width: FILM_WIDTH, height: FILM_HEIGHT }}
        aria-label={label}
        aria-current={current || undefined}
        data-testid="gallery-film-frame"
        data-gallery-index={index}
        onClick={() => {
          onPick(index);
        }}
      >
        <ThumbFace thumb={thumb} image={image} alt="" />
      </button>
    </Tip>
  );
}

/** The images in a row under the one showing, virtualized, keeping that one in view. */
function Filmstrip({ images, at, store, onPick }: { images: readonly GalleryImage[]; at: number; store: ThumbStore; onPick: (index: number) => void }) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({ horizontal: true, count: images.length, getScrollElement: () => box, estimateSize: () => FILM_WIDTH + FILM_GAP, overscan: 4, paddingStart: FILM_GAP, paddingEnd: FILM_GAP });
  useEffect(() => {
    if (box) v.scrollToIndex(at, { align: "auto" });
  }, [v, at, box]);
  return (
    <div ref={setBox} className="shrink-0 overflow-x-auto overflow-y-hidden border-t border-cf-divider py-2" data-testid="gallery-filmstrip">
      <div className="relative" style={{ width: v.getTotalSize(), height: FILM_HEIGHT }}>
        {v.getVirtualItems().map((f) => {
          const image = images[f.index];
          return image ? (
            <div key={f.key} className="absolute top-0 left-0" style={{ transform: `translateX(${String(f.start)}px)` }}>
              <FilmFrame image={image} index={f.index} current={f.index === at} store={store} onPick={onPick} />
            </div>
          ) : null;
        })}
      </div>
    </div>
  );
}

/**
 * One image large over the filmstrip. It takes the keyboard when it opens and after every move,
 * from the box itself: a filmstrip button the arrows scroll away would take the keys with it.
 * A re-open from the thread moves nothing but the images, so it never takes the keyboard.
 */
export function GallerySingle({ base, images, at, store, onMove, onClose }: { base: string; images: readonly GalleryImage[]; at: number; store: ThumbStore; onMove: (index: number) => void; onClose: () => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    root.current?.focus({ preventScroll: true });
  }, []);
  const move = (index: number) => {
    onMove(index);
    root.current?.focus({ preventScroll: true });
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const chord = chordFromEvent(e.nativeEvent);
    const next = chord === null ? null : singleKey(chord, at, images.length);
    if (next === null) return;
    e.preventDefault();
    e.stopPropagation();
    if (next === "grid") onClose();
    else move(next);
  };
  const image = images[at];
  if (!image) return null;
  const label = imageLabel(image);
  return (
    <div ref={root} tabIndex={-1} className="flex min-h-0 flex-1 flex-col outline-none" data-testid="gallery-single" onKeyDown={onKeyDown}>
      <div className="flex h-9 shrink-0 items-center gap-2 border-b border-cf-divider px-2">
        <HeaderAction icon={ArrowLeft} label="Back to grid" testId="gallery-back" onClick={onClose} />
        <Tip label={label} whenTruncated>
          <span className="min-w-0 flex-1 truncate text-label" data-testid="gallery-caption">
            {label}
          </span>
        </Tip>
        <span className="shrink-0 text-caption" data-testid="gallery-position">
          {at + 1} of {images.length}
        </span>
      </div>
      <FullImage key={imageKey(image)} base={base} image={image} store={store} />
      <Filmstrip images={images} at={at} store={store} onPick={move} />
    </div>
  );
}
