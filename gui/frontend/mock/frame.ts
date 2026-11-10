/**
 * The script the daemon writes into every HTML document a frame navigates to
 * (internal/preview/frame.js, frame.go), read from the daemon's own source so the mock
 * serves the same one.
 */
import { readFileSync } from "node:fs";

const script = readFileSync(new URL("../../../internal/preview/frame.js", import.meta.url), "utf8");

/** The inline script tag, as internal/preview frameTag. */
export const frameTag = `<script>${script}</script>`;

/** Whether a request loads a document into a frame or a window (internal/preview navigated). */
export function navigated(dest: string | undefined, themed: boolean): boolean {
  if (dest === "document" || dest === "iframe" || dest === "frame") return true;
  return dest === undefined && themed;
}
