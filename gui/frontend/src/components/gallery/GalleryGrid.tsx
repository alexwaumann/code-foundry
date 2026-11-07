import { memo, useEffect, useMemo, useState, type RefObject } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useElementWidth } from "@/components/plugin/layout";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { imageKey, imageLabel, type GalleryImage } from "@/surfaces/galleryTarget";
import { GRID_GAP, GRID_PAD, gridColumns, gridRow } from "./layout";
import { ThumbFace } from "./ThumbFace";
import type { ThumbStore } from "./thumbStore";
import { useThumb } from "./useThumb";

/** One tile: the image's thumbnail, opening it, over its caption. */
const GalleryTile = memo(function GalleryTile({ image, index, height, store, onOpen }: { image: GalleryImage; index: number; height: number; store: ThumbStore; onOpen: (index: number) => void }) {
  const thumb = useThumb(store, image);
  const label = imageLabel(image);
  // A failed tile names its file itself, so its line is only for a caption.
  const line = thumb.state === "failed" ? image.caption : label;
  return (
    <div className="min-w-0" data-testid="gallery-cell">
      <button
        type="button"
        className={cn(
          "block w-full overflow-hidden rounded-lg border border-cf-divider bg-cf-surface-sunken outline-none",
          "hover:border-cf-text-muted focus-visible:border-cf-accent focus-visible:ring-2 focus-visible:ring-cf-accent/40",
        )}
        style={{ height }}
        aria-label={thumb.state === "failed" ? `${label}: ${thumb.reason}` : label}
        data-testid="gallery-tile"
        data-state={thumb.state}
        data-gallery-index={index}
        onClick={() => {
          onOpen(index);
        }}
      >
        <ThumbFace thumb={thumb} image={image} alt="" named />
      </button>
      {line && (
        <Tip label={line} whenTruncated>
          <p className="mt-1.5 truncate text-caption">{line}</p>
        </Tip>
      )}
    </div>
  );
});

interface GridProps {
  images: readonly GalleryImage[];
  store: ThumbStore;
  onOpen: (index: number) => void;
  /** Where the grid was scrolled to, kept across the single view. */
  offsetRef: RefObject<number>;
  /** The tile to bring into view and give the keyboard when the grid comes back; null for none. */
  reveal: number | null;
}

/**
 * The rows. They mount once the box has a width, so that the first render has its full height
 * and the virtualizer's offset lands where it was.
 */
function GridRows({ images, store, onOpen, offsetRef, reveal, box, width }: GridProps & { box: HTMLElement; width: number }) {
  const columns = gridColumns(width);
  const { tile, row } = gridRow(width, columns);
  const rows = useMemo(() => {
    const out: (readonly GalleryImage[])[] = [];
    for (let i = 0; i < images.length; i += columns) out.push(images.slice(i, i + columns));
    return out;
  }, [images, columns]);
  // oxlint-disable-next-line react/incompatible-library -- TanStack Virtual returns unstable functions by design.
  const v = useVirtualizer({ count: rows.length, getScrollElement: () => box, estimateSize: () => row, overscan: 2, paddingStart: GRID_PAD, paddingEnd: GRID_PAD, initialOffset: () => offsetRef.current });
  useEffect(() => {
    v.measure();
  }, [v, row, columns]);
  useEffect(() => {
    if (reveal === null) return;
    v.scrollToIndex(Math.floor(reveal / columns), { align: "auto" });
    // The tile's row draws after the scroll's event.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        box.querySelector<HTMLElement>(`[data-gallery-index="${String(reveal)}"]`)?.focus({ preventScroll: true });
      });
    });
    return () => {
      cancelAnimationFrame(frame);
    };
    // Once, as the grid comes back: a resize later must not take the keyboard.
    // oxlint-disable-next-line react/exhaustive-deps
  }, [reveal, box]);
  return (
    <div className="relative w-full" style={{ height: v.getTotalSize() }}>
      {v.getVirtualItems().map((r) => (
        <div
          key={r.key}
          className="absolute inset-x-0 top-0 grid"
          style={{ transform: `translateY(${String(r.start)}px)`, height: row - GRID_GAP, paddingInline: GRID_PAD, columnGap: GRID_GAP, gridTemplateColumns: `repeat(${String(columns)}, minmax(0, 1fr))` }}
        >
          {rows[r.index]?.map((image, i) => (
            <GalleryTile key={imageKey(image) + String(i)} image={image} index={r.index * columns + i} height={tile} store={store} onOpen={onOpen} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The images as a grid, as many columns as the box takes, virtualized by rows of a height the
 * width gives. It scrolls on its own, which is what lets it come back where it was.
 */
export function GalleryGrid(props: GridProps) {
  const [box, setBox] = useState<HTMLDivElement | null>(null);
  const width = useElementWidth(box);
  const { offsetRef } = props;
  return (
    <div
      ref={setBox}
      className="min-h-0 flex-1 overflow-auto"
      data-testid="gallery-grid"
      data-columns={width === null ? undefined : gridColumns(width)}
      onScroll={(e) => {
        offsetRef.current = e.currentTarget.scrollTop;
      }}
    >
      {box && width !== null && <GridRows {...props} box={box} width={width} />}
    </div>
  );
}
