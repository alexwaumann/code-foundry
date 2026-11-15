import { useCallback } from "react";
import { ImagePreview } from "../ImagePreview";
import { imageMeta } from "./meta";
import type { PreviewBodyProps } from "./types";

/** An image kind's body (image, SVG): the picture, and its natural size in the meta once it decodes. */
export function ImageBody({ file, path, name, onMeta }: PreviewBodyProps) {
  const onSize = useCallback(
    (w: number, h: number) => {
      onMeta(imageMeta({ file, path }, { w, h }));
    },
    [file, path, onMeta],
  );
  return file.image && <ImagePreview bytes={file.image} mime={file.mime} name={name} onSize={onSize} />;
}
