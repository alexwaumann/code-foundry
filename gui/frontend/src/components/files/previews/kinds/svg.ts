import { ImageBody } from "../ImageBody";
import { imageMeta } from "../meta";
import type { PreviewKind } from "../types";

/**
 * SVG: Image | Source. The picture is the image kind's (an <img>, which runs none of the
 * file's scripts); Source is its text. No pencil: the daemon's edit rule calls an SVG an
 * image (internal/fsx/editable.go, api/files.ts canEdit), and this kind does not change it.
 */
const svg: PreviewKind = {
  id: "svg",
  match: { ext: ["svg"], mime: ["image/svg+xml"] },
  shows: (f) => f.image !== null,
  modes: [{ id: "image", label: "Image" }],
  Body: ImageBody,
  meta: (f) => imageMeta(f),
  tooLarge: "Image",
  source: { lang: "xml", name: "SVG" },
};

export default svg;
