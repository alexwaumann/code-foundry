import { useBlobSrc } from "./useBlobSrc";
import "./files.css";

/**
 * An image file, centred on a checker (transparency shows) and scaled down to fit. SVG is
 * shown through <img>, which runs none of its scripts. `onSize` reports its natural size
 * for the header's meta.
 */
export function ImagePreview({ bytes, mime, name, onSize }: { bytes: Uint8Array; mime: string; name: string; onSize: (w: number, h: number) => void }) {
  const src = useBlobSrc(bytes, mime);
  return (
    <div className="cf-checker flex min-h-0 flex-1 items-center justify-center overflow-auto p-4" data-testid="file-image">
      <img
        ref={src}
        alt={name}
        className="max-h-full max-w-full object-contain"
        onLoad={(e) => {
          onSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight);
        }}
      />
    </div>
  );
}
