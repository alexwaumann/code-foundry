import type { ReactNode } from "react";
import { extOf } from "@/lib/filePath";
import { formatSize } from "../fileKind";
import { SavedAgo } from "./SavedAgo";
import type { PreviewFile } from "./types";

/** A rendered page's meta: "saved 2m ago · 4 KB" (the size alone when the time is not known). */
export function savedMeta({ file }: PreviewFile): ReactNode {
  return (
    <>
      <SavedAgo ms={file.modifiedAtMs} />
      {file.modifiedAtMs !== null && " · "}
      {formatSize(file.size)}
    </>
  );
}

/** An image's meta: "512 × 512 · 1 KB · SVG", the size once it decoded; the mime when the name has no extension. */
export function imageMeta({ file, path }: PreviewFile, dims?: { w: number; h: number }): string {
  const size = dims ? `${String(dims.w)} × ${String(dims.h)} · ` : "";
  return `${size}${formatSize(file.size)} · ${extOf(path).toUpperCase() || file.mime}`;
}
