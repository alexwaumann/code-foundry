import { useCallback } from "react";

/**
 * A callback ref for an <img> that shows bytes of a type: it points the image at an object
 * URL while attached and revokes it when the image detaches or the bytes change (a ref
 * cleanup, so no state and no effect). Null bytes leave the image without a source.
 */
export function useBlobSrc(bytes: Uint8Array | null, type: string): (img: HTMLImageElement | null) => (() => void) | undefined {
  return useCallback(
    (img: HTMLImageElement | null) => {
      if (!img || !bytes) return undefined;
      // A copy: a Blob wants an ArrayBuffer-backed view, and the response's bytes may sit in a larger buffer.
      const url = URL.createObjectURL(new Blob([bytes.slice()], { type }));
      img.src = url;
      return () => {
        URL.revokeObjectURL(url);
      };
    },
    [bytes, type],
  );
}
