import { useEffect, useSyncExternalStore } from "react";
import { imageKey, type GalleryImage } from "@/surfaces/galleryTarget";
import type { Thumb, ThumbStore } from "./thumbStore";

/** The image's thumb, held while the caller is mounted: what keeps it loaded and what starts it. */
export function useThumb(store: ThumbStore, image: GalleryImage): Thumb {
  const key = imageKey(image);
  const thumb = useSyncExternalStore(
    (listener) => store.subscribe(key, listener),
    () => store.peek(key),
  );
  // image is the entry the key stands for, so the key is enough.
  // oxlint-disable-next-line react/exhaustive-deps
  useEffect(() => store.hold(image), [store, key]);
  return thumb;
}
